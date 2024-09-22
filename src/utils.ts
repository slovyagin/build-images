export const invertColor = (hex: string) => {
	if (hex.indexOf('#') === 0) hex = hex.slice(1);
	if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
	if (hex.length !== 6) return false;

	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);

	return r * 0.299 + g * 0.587 + b * 0.114 > 186;
};

export const transformCloudinaryUrl = (originalUrl: string, size: number | null = null) => {
	const url = new URL(originalUrl);
	let fileName = url.pathname.split('/').pop() || '';
	const aParam = url.searchParams.get('_a');

	// Replace the file extension with .avif
	fileName = fileName.replace(/\.[^/.]+$/, '.avif');

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
};
