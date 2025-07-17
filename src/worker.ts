import { type Context, Hono, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';

import type { KVNamespace } from '@cloudflare/workers-types';
import type { StatusCode } from 'hono/utils/http-status';

import { invertColor, transformCloudinaryUrl } from './utils';

// Define image size constants for different viewport sizes
const MOBILE_SIZE = 700;
const BASELINE_SIZE = 900;
const LARGE_SIZE = 1400;
const ITEMS_PER_PAGE = 40;

/**
 * Environment variables and bindings required by the worker
 */
interface Env {
	API_SECRET_KEY: string;               // Key for API authentication
	CLOUDINARY_API_KEY: string;           // Cloudinary API credentials
	CLOUDINARY_API_SECRET: string;        // Cloudinary API credentials
	CLOUDINARY_CLOUD_NAME: string;        // Cloudinary account name
	CLOUDINARY_FOLDER_PREFIX: string;     // Folder path in Cloudinary
	CLOUDINARY_RESOURCES_KV_KEY_NAME: string;  // KV storage key for Cloudinary resources
	HOMEPAGE_KV: KVNamespace;             // KV namespace for caching
	IMAGES_KV_KEY_NAME: string;           // KV storage key for processed images
}

/**
 * Represents a resource from Cloudinary API
 */
interface CloudinaryResource {
	asset_id: string;        // Unique identifier for the asset
	height: number;          // Image height in pixels
	width: number;           // Image width in pixels
	colors: string[][];      // Color palette extracted from image
	public_id: string;       // Public identifier in Cloudinary
	secure_url: string;      // HTTPS URL to the resource
	context?: {              // Optional context metadata
		custom?: {
			caption?: string;  // Optional custom caption
		};
	};
	image_metadata?: {       // Optional EXIF/image metadata
		'Caption-Abstract'?: string;  // Caption from image metadata
	};
}

/**
 * Processed image data structure ready for frontend consumption
 */
interface Image {
	backgroundColor: string;  // Background color for image container
	caption: string | null;   // Image caption text
	color: 'black' | 'white'; // Text color for contrast with background
	height: number;           // Image height
	id: string;               // Unique identifier
	mobileUrl: string;        // URL optimized for mobile devices
	largeUrl: string;         // URL for high-resolution displays
	url: string;              // Standard URL for normal displays
	width: number;            // Image width
}

/**
 * Fetches a list of resources from a Cloudinary folder
 *
 * @param env - Environment variables with Cloudinary credentials
 * @returns Promise containing array of Cloudinary resources
 */
async function fetchFolder(env: Env): Promise<{ resources: CloudinaryResource[] }> {
	// Build Cloudinary API URL with query parameters
	const response = await fetch(
		`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/by_asset_folder?${new URLSearchParams({
			asset_folder: env.CLOUDINARY_FOLDER_PREFIX,
			max_results: '500',
			context: '1',               // Include context metadata
			metadata: '1',              // Include image metadata
		}).toString()}`,
		{
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				// Create Basic Auth header from credentials
				Authorization: `Basic ${btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`)}`,
			},
		},
	);

	// Handle API errors
	if (!response.ok) {
		throw new HTTPException(response.status as StatusCode, { message: `Cloudinary API error: ${response.statusText}` });
	}

	return await response.json();
}

/**
 * Fetches detailed information about a specific Cloudinary resource
 *
 * @param env - Environment variables with Cloudinary credentials
 * @param publicId - The public ID of the resource to fetch
 * @returns Promise containing detailed resource information
 */
async function fetchResource(env: Env, publicId: string): Promise<CloudinaryResource> {
	// Build API URL for specific resource with color and metadata parameters
	const response = await fetch(
		`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/${publicId}?${new URLSearchParams({
			colors: '1',           // Include color palette information
			image_metadata: '1',   // Include full image metadata
		})}`,
		{
			headers: {
				// Create Basic Auth header from credentials
				Authorization: `Basic ${btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`)}`,
			},
		},
	);

	// Handle API errors
	if (!response.ok) {
		throw new HTTPException(response.status as StatusCode, { message: `Cloudinary resource details error: ${response.statusText}` });
	}

	return await response.json();
}

/**
 * Processes Cloudinary resources into standardized Image objects
 *
 * @param env - Environment variables
 * @param resources - Array of Cloudinary resources to process
 * @returns Promise containing array of processed Images
 */
async function processResources(env: Env, resources: CloudinaryResource[]): Promise<Image[]> {
	const images: Image[] = [];

	// Process each resource into a standardized Image object
	for (const item of resources) {
		try {
			const res = await fetchResource(env, item.asset_id);
			const assetId = item.asset_id.substring(0, 4);
			const backgroundColor = res.colors?.[3]?.[0]?.toLowerCase() ?? '#fff';
			const caption = res?.image_metadata?.['Caption-Abstract'] ?? null;
			// Create URL transformer function for different sizes
			const url = (size: number) => transformCloudinaryUrl(res.secure_url, size);

			// Build the standardized Image object
			images.push({
				backgroundColor,
				caption,
				// Determine text color based on background brightness
				color: invertColor(backgroundColor) ? 'black' : 'white',
				height: res.height ?? 0,
				// Create a slug-like ID from caption or use placeholder
				id: caption ? `${[caption.toLowerCase().replace(/, | /g, '-'), assetId].join('-')}` : `p-${assetId}`,
				largeUrl: url(LARGE_SIZE),
				mobileUrl: url(MOBILE_SIZE),
				url: url(BASELINE_SIZE),
				width: res.width ?? 0,
			});
		} catch (error) {
			console.error(`Error processing resource ${item.public_id}:`, error);

			throw new HTTPException(500, { message: error.message });
		}
	}

	return images;
}

const app = new Hono<{ Bindings: Env }>();

app.use(logger());

/**
 * Global error handling middleware
 * Returns appropriate HTTP responses for different error types
 */
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return err.getResponse();
	}

	return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

/**
 * Authentication middleware
 * Verifies API key in request header against environment variable
 */
const auth = async (c: Context<{ Bindings: Env }>, next: Next) => {
	const apiKey = c.req.header('X-API-Key');

	if (apiKey !== c.env.API_SECRET_KEY) {
		throw new HTTPException(401, { message: 'Unauthorized' });
	}

	await next();
};

const paginate = async (c: Context<{ Bindings: Env }>, next: Next) => { }

/**
 * Main endpoint for retrieving images
 * Handles caching, pagination, and image processing
 */
app.get('/', auth, async (c) => {
	// Fetch both cached and current resources in parallel
	const [storedResources, currentResources] = await Promise.all([
		c.env.HOMEPAGE_KV.get<Record<string, unknown>>(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, 'json'),
		fetchFolder(c.env),
	]);

	// Check if resources have changed or force mode
	const resourcesHaveChanged = JSON.stringify(storedResources) !== JSON.stringify(currentResources);
	const forceRegenerate = c.req.query('force') === 'true';

	// If resources changed or force regeneration, update cache
	if (resourcesHaveChanged || forceRegenerate) {
		await Promise.all([
			// Store current resources in KV storage
			c.env.HOMEPAGE_KV.put(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, JSON.stringify(currentResources)),
			// Reset image cache
			c.env.HOMEPAGE_KV.put(c.env.IMAGES_KV_KEY_NAME, JSON.stringify({})),
		]);
	}

	// Parse requested page number from query params
	const currentPage = Number.parseInt(c.req.query('page') || '1', 10);

	// Get cached processed images
	const storedImages = await c.env.HOMEPAGE_KV.get<Record<number, Image[]>>(c.env.IMAGES_KV_KEY_NAME, 'json');

	// Calculate pagination indices
	const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
	const endIndex = startIndex + ITEMS_PER_PAGE;
	const totalResources = currentResources.resources.length;
	const totalPages = Math.ceil(totalResources / ITEMS_PER_PAGE);

	// Use cached images for the current page if available
	let images: Image[] = storedImages?.[currentPage] || [];

	// If no cached images for current page and page is valid, process resources
	if (!storedImages?.[currentPage] && currentPage > 0 && currentPage <= totalPages) {
		// Get subset of resources for current page
		const paginatedResources = currentResources.resources.slice(startIndex, endIndex);

		// Process resources into standardized Image objects
		images = await processResources(c.env, paginatedResources);

		// Update cache with newly processed images
		await c.env.HOMEPAGE_KV.put(
			c.env.IMAGES_KV_KEY_NAME,
			JSON.stringify({
				...storedImages,
				[currentPage]: images,
			}),
		);
	}

	// Return JSON response with images and pagination metadata
	return c.json({
		images,
		pagination: {
			current_page: currentPage,
			per_page: ITEMS_PER_PAGE,
			total_pages: totalPages,
			total_items: totalResources,
		},
	});
});

/**
 * Development endpoint for retrieving cached images only
 * Useful for testing without hitting Cloudinary API
 */
app.get('/dev', auth, async (c) => {
  // Parse requested page number from query params
  const currentPage = Number.parseInt(c.req.query('page') || '1', 10);

  // Fetch cached resources and images in parallel
  const [storedResources, storedImages] =  await Promise.all([
    c.env.HOMEPAGE_KV.get<Record<string, unknown>>(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, 'json'),
    c.env.HOMEPAGE_KV.get<Record<number, Image[]>>(c.env.IMAGES_KV_KEY_NAME, 'json')
  ]);

  // Get cached images for current page
  const images: Image[] = storedImages?.[currentPage] || [];

  // Calculate pagination metadata
  const totalResources = storedResources?.resources.length;
  const totalPages = Math.ceil(totalResources / ITEMS_PER_PAGE);

  // Return JSON response with images and pagination metadata
  return c.json({
		images,
		pagination: {
			current_page: currentPage,
			per_page: ITEMS_PER_PAGE,
			total_pages: totalPages,
			total_items: totalResources,
		},
	});
});

export default app;
