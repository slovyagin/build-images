const rgbToHsl = (r: number, g: number, b: number) => {
	const red = r / 255;
	const green = g / 255;
	const blue = b / 255;
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	let h: number;
	let s: number;
	const l = (max + min) / 2;
	if (max === min) {
		h = s = 0;
	} else {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case red:
				h = (green - blue) / d + (green < blue ? 6 : 0);
				break;
			case green:
				h = (blue - red) / d + 2;
				break;
			case blue:
				h = (red - green) / d + 4;
				break;
		}
		// @ts-ignore
		h = h / 6;
	}
	return [h, s, l];
};

export const invertColor = (hex: string) => {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	
	if (!result) {
		return false;
	}
	
	const r = Number.parseInt(result[1] ?? '0', 16);
	const g = Number.parseInt(result[2] ?? '0', 16);
	const b = Number.parseInt(result[3] ?? '0', 16);

	return Number(rgbToHsl(r, g, b)[2]) > 0.5;
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
		params.set('s', size.toString());
	}

	if (params.toString()) {
		newUrl += '?' + params.toString();
	}

	return newUrl;
};
