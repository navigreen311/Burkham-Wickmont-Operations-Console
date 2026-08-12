/**
 * @bwc/deliverables - 3.1 Document & Deliverable Management + 3.4 Deliverable Approval Workflow.
 *
 * The artifact of record is the structured content document, hashed and anchored in the Event
 * Ledger. The PDF is a rendering of it (ADR-0005), so the evidence survives a font substitution
 * or a library upgrade.
 */

export * from './content.js';
export * from './render.js';
export * from './approval.js';
export * from './templates.js';
export * from './seed.js';
