/**
 * What a route module needs from the app that hosts it.
 *
 * **This file is a debt the codebase asked to have paid.** Four route modules carried a
 * structurally identical `ConsoleRouteContext` and a comment saying it "should collapse into
 * `routes/context.ts` the moment anybody owns both" - the duplication was a consequence of file
 * ownership during a parallel wave, not a design. Twenty-two copies existed by the time anybody
 * owned all of them.
 *
 * Seven modules adopt it here: the ones gaining writes in Batch A. The rest are read-only, do not
 * need `authorised`, and are left alone rather than swept into a change about something else -
 * each later batch collapses the ones it touches.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import type { ACTION_MINIMUM_LEVEL } from '@bwc/core';
import type { StepTrace } from '@bwc/middleware';
import type { Actor } from '@bwc/identity';

export interface ConsoleRouteContext {
  readonly app: Express;
  readonly tenantId: string;
  readonly now: () => Date;
  /** Has already replied when it returns undefined. */
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly jsonBody: RequestHandler;
  /**
   * Authenticate, then run the middleware chain for one action.
   *
   * **The reason a Console write goes through here and not through `requireStaff` alone.** A
   * session says who is asking; it says nothing about whether they may do this. Before these
   * actions were declared, every capability below was reachable only through a module function
   * whose own gate was the only check - which is exactly the defect ADR-0033 named, one layer
   * further in.
   *
   * Returns undefined having already replied, with the trace attached to the refusal: "which step
   * blocked this" is the first question anybody asks, and on a page it is the difference between a
   * dead end and an instruction.
   */
  readonly authorised: (
    req: Request,
    res: Response,
    input: { action: keyof typeof ACTION_MINIMUM_LEVEL; clientId?: string },
  ) => Promise<{ actor: Actor; trace: readonly StepTrace[] } | undefined>;
}
