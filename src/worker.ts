import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { cache } from 'hono/cache';

import type { KVNamespace } from '@cloudflare/workers-types';
import type { StatusCode } from 'hono/utils/http-status';

// Constants
const MOBILE_SIZE = 800;
const BASELINE_SIZE = 1280;
const LARGE_SIZE = 1400;

// Interfaces
interface Env {
	HOMEPAGE_KV: KVNamespace;
	CLOUDINARY_RESOURCES_KV_KEY_NAME: string;
	IMAGES_KV_KEY_NAME: string;
	API_SECRET_KEY: string;
	CLOUDINARY_CLOUD_NAME: string;
	CLOUDINARY_API_KEY: string;
	CLOUDINARY_API_SECRET: string;
	CLOUDINARY_FOLDER_PREFIX: string;
	NODE_ENV?: string;
}

interface CloudinaryResource {
	public_id: string;
}

interface CloudinaryResourceDetails {
	secure_url: string;
	colors: string[][];
	context?: {
		custom?: {
			caption?: string;
		};
	};
	asset_id: string;
	height: number;
	width: number;
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

function invertColor(hex: string): boolean {
	if (hex.indexOf('#') === 0) hex = hex.slice(1);
	if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
	if (hex.length !== 6) return false;

	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return r * 0.299 + g * 0.587 + b * 0.114 > 186;
}

function shuffle<T>(array: T[]): T[] {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}

	return array;
}

function transformCloudinaryUrl(originalUrl: string, size: number | null = null): string {
	const url = new URL(originalUrl);
	const fileName = url.pathname.split('/').pop() || '';
	const aParam = url.searchParams.get('_a');
	let newUrl = `https://images.slovyagin.com/${fileName}`;
	const params = new URLSearchParams();

	if (aParam) {
		params.set('_a', aParam);
	}

	if (size) {
		params.set('h', size.toString());
		params.set('w', size.toString());
	}

	if (params.toString()) {
		newUrl += '?' + params.toString();
	}

	return newUrl;
}

async function fetchCloudinaryResources(env: Env): Promise<{ resources: CloudinaryResource[] }> {
	const response = await fetch(
		`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/by_asset_folder?${new URLSearchParams({
			asset_folder: env.CLOUDINARY_FOLDER_PREFIX,
			max_results: '500',
			context: 'true',
			metadata: 'true',
		}).toString()}`,
		{
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Basic ${btoa(env.CLOUDINARY_API_KEY + ':' + env.CLOUDINARY_API_SECRET)}`,
			},
		},
	);

	if (!response.ok) {
		throw new HTTPException(response.status as StatusCode, { message: `Cloudinary API error: ${response.statusText}` });
	}

	return await response.json();
}

async function fetchCloudinaryResourceDetails(env: Env, publicId: string): Promise<CloudinaryResourceDetails> {
	const response = await fetch(
		`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/image/upload/${publicId}?${new URLSearchParams({
			colors: '1',
			media_metadata: '1',
		})}}`,
		{
			headers: {
				Authorization: `Basic ${btoa(env.CLOUDINARY_API_KEY + ':' + env.CLOUDINARY_API_SECRET)}`,
			},
		},
	);

	if (!response.ok) {
		throw new HTTPException(response.status as StatusCode, { message: `Cloudinary resource details error: ${response.statusText}` });
	}

	return await response.json();
}

async function processCloudinaryResources(env: Env, resources: CloudinaryResource[]): Promise<Image[]> {
	const images: Image[] = [];

	for (const item of resources) {
		try {
			const res = await fetchCloudinaryResourceDetails(env, item.public_id);
			const baseUrl = transformCloudinaryUrl(res.secure_url, BASELINE_SIZE);
			const color = res.colors && res.colors.length > 3 ? res.colors[3][0].toLowerCase() : 'transparent';
			const caption = res.context?.custom?.caption || null;
			const assetId = res.asset_id.substring(0, 4);

			images.push({
				backgroundColor: color,
				caption,
				color: invertColor(color) ? 'black' : 'white',
				height: res.height || 0,
				id: caption ? `${[caption.toLowerCase().replace(/, | /g, '-'), assetId].join('-')}` : `p-${assetId}`,
				mobileUrl: transformCloudinaryUrl(res.secure_url, MOBILE_SIZE),
				largeUrl: transformCloudinaryUrl(res.secure_url, LARGE_SIZE),
				url: baseUrl,
				width: res.width || 0,
			});
		} catch (error) {
			console.error(`Error processing resource ${item.public_id}:`, error);
		}
	}

	return images;
}

const app = new Hono<{ Bindings: Env }>();
app.use(logger());
app.use(prettyJSON());
app.get(
  '*',
  cache({
    cacheName: 'build-images',
    cacheControl: 'max-age=36000',
  })
)

// Error handling middleware
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return err.getResponse();
	}

	return c.json({ error: 'Internal Server Error' }, 500);
});

// Authentication middleware
const auth = async (c, next) => {
	if (c.env.NODE_ENV === 'development') {
		await next();
	} else {
		const apiKey = c.req.header('X-API-Key');

		if (apiKey !== c.env.API_SECRET_KEY) {
			throw new HTTPException(401, { message: 'Unauthorized' });
		}

		await next();
	}
};

app.get('/', auth, async (c) => {
	const [storedResources, storedImages] = await Promise.all([
		c.env.HOMEPAGE_KV.get(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, 'json'),
		c.env.HOMEPAGE_KV.get(c.env.IMAGES_KV_KEY_NAME, 'json'),
	]);

	const currentResources = await fetchCloudinaryResources(c.env);
	let images: Image[] = storedImages || [];

	const hasStoredResources = !!storedResources;
	const resourcesHaveChanged = JSON.stringify(storedResources) !== JSON.stringify(currentResources);

	if (!hasStoredResources || resourcesHaveChanged) {
		images = await processCloudinaryResources(c.env, currentResources.resources);

		if (images.length > 0) {
			await Promise.all([
				c.env.HOMEPAGE_KV.put(c.env.CLOUDINARY_RESOURCES_KV_KEY_NAME, JSON.stringify(currentResources)),
				c.env.HOMEPAGE_KV.put(c.env.IMAGES_KV_KEY_NAME, JSON.stringify(images)),
			]);
		} else {
			images = storedImages || [];
		}
	}

	const shuffled = shuffle(images);
	
	return c.json(shuffled);
});

export default app;
