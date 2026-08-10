/**
 * @bwc/intelligence - 3.3 Document Intelligence Pipeline.
 *
 * Split along the line the vendor gates draw: ingestion is consent-gated and reports `not_built`
 * for the three ungated V1 vendors, while normalization, enrichment and correlation are pure
 * functions over a shape we own and are fully built and tested.
 */

export * from './normalized.js';
export * from './categorize.js';
export * from './analyze.js';
export * from './correlate.js';
export * from './documents.js';
export * from './ingest.js';
