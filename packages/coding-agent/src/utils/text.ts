/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return splitBom(content).text;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Replace each run of C0/C1 control characters with a space, so untrusted text cannot drive the terminal. */
export function replaceControlCharacters(str: string): string {
	return str.replace(CONTROL_CHARACTERS, " ");
}
