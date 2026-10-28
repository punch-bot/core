// Providers do not need host details, so the User-Agent names the client only. OS release and CPU architecture would
// fingerprint the machine the bot runs on.
export function getPiUserAgent(): string {
	return "punch-agent";
}
