/**
 * Vendor activation surface - 11.5 with ADR-0065.
 *
 * Read-only over HTTP, and that is a decision rather than an omission.
 *
 * **There is no POST here that accepts evidence.** A form is the natural place to put one, and a
 * form is exactly what turns this control into a checkbox: somebody with a Console session and a
 * text box will type `SOC 2 cleared` into it. Accepting evidence needs the document in front of
 * the person, a Level 3 human who has read it, and a reference that points at something an auditor
 * can pull. Until there is a flow that carries the document itself - the Vault (3.2) already
 * stores documents and could hold the attestation - the recording path is `recordEvidence` called
 * deliberately, not a field on a page.
 *
 * That is the "if you cannot require evidence, refuse the feature" line from this slice's brief,
 * applied to the surface rather than to the model. The model requires evidence; the page does not
 * yet have a way to carry it, so the page does not offer to.
 *
 * What the page does show is the thing an operator actually needs: **what is outstanding per
 * vendor, who accepted what, and when** - including expiry, so an attestation running out is
 * visible before it closes the gate rather than after.
 */

import type { Express, Request, Response } from 'express';
import { activationBoard, mayOnboardClients, mode } from '@bwc/integration';

export interface IntegrationRouteDeps {
  readonly app: Express;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  /** Returns undefined and has already replied when there is no staff session. */
  readonly requireStaff: (req: Request, res: Response) => Promise<unknown>;
}

export const registerIntegrationRoutes = ({
  app,
  asyncRoute,
  requireStaff,
}: IntegrationRouteDeps): void => {
  /**
   * The activation board.
   *
   * Behind a staff session, like `/api/health/integrations` already is: it names every vendor this
   * firm has not cleared and what each is waiting on, which is a map of where the controls are not
   * yet in place.
   */
  app.get(
    '/api/integrations/activation',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const [board, onboarding] = await Promise.all([activationBoard(), mayOnboardClients()]);

      res.json({
        status: 'ok',
        data: {
          mode: mode(),
          // The headline. CLAUDE.md's standing constraint, answered rather than implied.
          clientOnboarding: {
            permitted: onboarding.status === 'ok',
            explanation:
              onboarding.status === 'ok'
                ? `Permitted since ${onboarding.value.since}.`
                : onboarding.reason,
          },
          vendors: board.map((standing) => ({
            vendor: standing.vendor,
            activated: standing.activated,
            explanation: standing.explanation,
            outstanding: standing.outstanding.map((item) => ({
              kind: item.kind,
              label: item.label,
              why: item.why,
            })),
            // Who accepted what, and when. The document reference travels, because a surface that
            // showed a green tick without it would be the checkbox this design refuses to be.
            accepted: standing.accepted.map((entry) => ({
              kind: entry.kind,
              documentReference: entry.documentReference,
              issuedBy: entry.issuedBy,
              issuedOn: entry.issuedOn,
              validUntil: entry.validUntil,
              acceptedBy: entry.acceptedBy,
              acceptedAt: entry.acceptedAt,
            })),
          })),
          recording: {
            available: false,
            reason:
              'Evidence is recorded through `recordEvidence`, not through this page. A text box on a screen is how "SOC 2 cleared" gets typed with nothing behind it; the recording path needs the document itself, which means routing it through the Vault first.',
          },
        },
      });
    }),
  );
};
