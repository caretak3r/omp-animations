export function ageText(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1_000));
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.min(9_999, Math.floor(hours / 24))}d`;
}
