/**
 * @bwc/calls - 4.3 Call Recording, Summaries & Promise Tracking.
 *
 * Blueprint 4.3 routes through CapitalForge -> VoiceForge, which is not gated in. So capture,
 * transcription and AI summary report `not_built`, and everything that operates on a transcript
 * once one exists is fully built - the same split 3.3 makes.
 *
 * Two decisions worth knowing before reading further:
 *
 *   A CONTROL THAT RUNS AFTER THE FACT PRODUCES AN OBLIGATION, NOT A VERDICT. The call already
 *   happened; the client already heard it. Returning `blocked` would describe a state of affairs
 *   that does not exist. So a detected promise becomes a correction owed to the client, with an
 *   owner, a deadline, and - to close it - the correction itself.
 *
 *   RECORDING CONSENT IS A JURISDICTION QUESTION. About eleven states require ALL parties to
 *   consent, and recording a client without their consent there is a crime in the state where the
 *   client is sitting. "With consent" cannot be a checkbox on our side.
 */

export * from './consent.js';
export * from './detect.js';
export * from './obligations.js';
export * from './capture.js';
