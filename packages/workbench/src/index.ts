/**
 * @bwc/workbench - 11.11 Founder / Executive Workbench.
 *
 * Stores nothing. Assembly over 9.1, 6.4, 4.3, 11.7 and 11.8, the way 7.1 assembles a client file.
 *
 * THE DECISION: the queue contains only what the FOUNDER must decide. A workbench that listed
 * everything would become a second inbox, and two inboxes means both get ignored - 11.4 already
 * has a task queue, and the failure of adding another is not that the second is wrong but that the
 * first stops being read.
 *
 * So an item appears only if it requires a Level 3 human, is blocking something, and carries WHAT
 * HAPPENS IF NOBODY ACTS. The last is what makes it a queue rather than a feed: "three items need
 * your attention" is a notification; "a client cannot be placed until this is reviewed, and they
 * have been waiting eleven days" is a decision.
 */

export * from './workbench.js';
