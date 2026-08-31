/**
 * Reduces a full User-Agent string to a coarse "browser/OS family" summary
 * (docs §2.6: "a summary... not the full string"). Deliberately simple
 * substring sniffing rather than a full UA-parser dependency — Phase 1 only
 * needs rough analytics buckets, not device-model precision, and a smaller
 * surface here means less personal data retained per §2.6's own warning
 * that this is still personal data even reduced.
 */
export function summarizeUserAgent(userAgent: string | null | undefined): string | null {
    if (!userAgent) return null;

    const browser = /Edg\//.test(userAgent)
        ? 'Edge'
        : /Chrome\//.test(userAgent)
            ? 'Chrome'
            : /Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)
                ? 'Safari'
                : /Firefox\//.test(userAgent)
                    ? 'Firefox'
                    : 'Other';

    const os = /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X/.test(userAgent)
            ? 'macOS'
            : /Android/.test(userAgent)
                ? 'Android'
                : /iPhone|iPad|iOS/.test(userAgent)
                    ? 'iOS'
                    : /Linux/.test(userAgent)
                        ? 'Linux'
                        : 'Other';

    return `${browser} / ${os}`;
}
