import { type Context, Hono, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';

import type { KVNamespace } from '@cloudflare/workers-types';
import type { StatusCode } from 'hono/utils/http-status';

import { invertColor, transformCloudinaryUrl } from './utils';

// Constants
const MOBILE_SIZE = 700;
const BASELINE_SIZE = 900;
const LARGE_SIZE = 1400;
const ITEMS_PER_PAGE = 40;

// Interfaces
interface Env {
	API_SECRET_KEY: string;
	CLOUDINARY_API_KEY: string;
	CLOUDINARY_API_SECRET: string;
	CLOUDINARY_CLOUD_NAME: string;
	CLOUDINARY_FOLDER_PREFIX: string;
	CLOUDINARY_RESOURCES_KV_KEY_NAME: string;
	HOMEPAGE_KV: KVNamespace;
	IMAGES_KV_KEY_NAME: string;
}

interface CloudinaryResource {
	asset_id: string;
	height: number;
	width: number;
	colors: string[][];
	public_id: string;
	secure_url: string;
	context?: {
		custom?: {
			caption?: string;
		};
	};
	image_metadata?: {
		'Caption-Abstract'?: string;
	};
}

interface Image {
	backgroundColor: string;
	caption: string | null;
	color: 'black' | 'white';
	height: number;
	id: string;
	mobileUrl: string;
	largeUrl: string;
	url: string;
	width: number;
}

async function fetchFolder(env: Env): Promise<{ resources: CloudinaryResource[] }> {
	const response = await fetch(
		`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/by_asset_folder?${new URLSearchParams({
			asset_folder: env.CLOUDINARY_FOLDER_PREFIX,
			max_results: '500',
			context: '1',
			metadata: '1',
		}).toString()}`,
		{
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Basic ${btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`)}`,
			},
		},
	);

	if (!response.ok) {
		throw new HTTPException(response.status as StatusCode, { message: `Cloudinary API error: ${response.statusText}` });
	}

	return await response.json();
}

async function fetchResource(env: Env, publicId: string): Promise<CloudinaryResource> {
	const response = await fetch(
		`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/${publicId}?${new URLSearchParams({
			colors: '1',
			image_metadata: '1',
		})}`,
		{
			headers: {
				Authorization: `Basic ${btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`)}`,
			},
		},
	);

	if (!response.ok) {
		throw new HTTPException(response.status as StatusCode, { message: `Cloudinary resource details error: ${response.statusText}` });
	}

	return await response.json();
}

async function processResources(env: Env, resources: CloudinaryResource[]): Promise<Image[]> {
	const images: Image[] = [];

	for (const item of resources) {
		try {
			const res = await fetchResource(env, item.asset_id);
			const baseUrl = transformCloudinaryUrl(res.secure_url, BASELINE_SIZE);
			const color = res.colors && res.colors.length > 3 ? res.colors[3][0].toLowerCase() : 'transparent';
			const caption = res?.image_metadata?.['Caption-Abstract'] ?? null;
			const assetId = res.asset_id.substring(0, 4);

			images.push({
				backgroundColor: color,
				caption,
				color: invertColor(color) ? 'black' : 'white',
				height: res.height || 0,
				id: caption ? `${[caption.toLowerCase().replace(/, | /g, '-'), assetId].join('-')}` : `p-${assetId}`,
				largeUrl: transformCloudinaryUrl(res.secure_url, LARGE_SIZE),
				mobileUrl: transformCloudinaryUrl(res.secure_url, MOBILE_SIZE),
				url: baseUrl,
				width: res.width || 0,
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

// Error handling middleware
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return err.getResponse();
	}

	return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Authentication middleware
const auth = async (c: Context<{ Bindings: Env }>, next: Next) => {
	const apiKey = c.req.header('X-API-Key');

	if (apiKey !== c.env.API_SECRET_KEY) {
		throw new HTTPException(401, { message: 'Unauthorized' });
	}

	await next();
};

app.get('/', auth, async (c) => {
	const [storedResources, currentResources] = await Promise.all([
		c.env.HOMEPAGE_KV.get<Record<string, unknown>>(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, 'json'),
		fetchFolder(c.env),
	]);
	const resourcesHaveChanged = JSON.stringify(storedResources) !== JSON.stringify(currentResources);
	const forceRegenerate = c.req.query('force') === 'true';

	if (resourcesHaveChanged || forceRegenerate) {
		await Promise.all([
			c.env.HOMEPAGE_KV.put(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, JSON.stringify(currentResources)),
			c.env.HOMEPAGE_KV.put(c.env.IMAGES_KV_KEY_NAME, JSON.stringify({})),
		]);
	}

	const currentPage = Number.parseInt(c.req.query('page') || '1', 10);
	const storedImages = await c.env.HOMEPAGE_KV.get<Record<number, Image[]>>(c.env.IMAGES_KV_KEY_NAME, 'json');
	const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
	const endIndex = startIndex + ITEMS_PER_PAGE;
	const totalResources = currentResources.resources.length;
	const totalPages = Math.ceil(totalResources / ITEMS_PER_PAGE);

	let images: Image[] = storedImages?.[currentPage] || [];

	if (!storedImages?.[currentPage] && currentPage > 0 && currentPage <= totalPages) {
		const paginatedResources = currentResources.resources.slice(startIndex, endIndex);

		images = await processResources(c.env, paginatedResources);

		await c.env.HOMEPAGE_KV.put(
			c.env.IMAGES_KV_KEY_NAME,
			JSON.stringify({
				...storedImages,
				[currentPage]: images,
			}),
		);
	}

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
