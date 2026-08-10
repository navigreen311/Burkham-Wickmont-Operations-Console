# Moving the address a client's account lives at

Module: 11.1 Identity & Access (for 11.10) · Package: `@bwc/identity` · Schema: `identity` ·
ADR: [0027](adr/0027-the-address-is-where-recovery-goes.md)

**The strongest of the three credential operations**, and the reason is one line: the email address
is where a reset link goes.

Changing a password changes what an attacker must know. Changing this changes **where recovery
goes** — and an attacker who moves it keeps the account after the client resets their password,
because the reset arrives in the attacker's inbox.

---

## Three decisions that run opposite to change-password

"Be consistent with the last slice" is the tempting wrong answer in all three.

|                   | Change password | **Move address**                                         |
| ----------------- | --------------- | -------------------------------------------------------- |
| Takes effect      | Immediately     | **Only when a token sent to the new address comes back** |
| Other sessions    | Revoked         | **Left alive**                                           |
| Outstanding reset | Spent           | **Left alive**                                           |

**Sessions and resets are left alive because nothing about authentication changed.** Revoking them
would remove the legitimate owner's access and leave the attacker — who is the one holding the
session doing the changing — exactly where they were. A reset in flight went to the _old_ address,
which an attacker does not have; it is the owner's way back.

**It takes effect only on confirmation** because a change applied at request time moves recovery to
whatever was typed. A typo is then not a typo: it is a lockout the client discovers on the day they
need to get back in.

## A staff-assisted move is a different fact, and a column says which

#28 solved "email is not gated in" with a Level 3 staff route that hands a token to a human to
convey. **That does not transfer here.** A token read to a client over the phone proves the
**person** — it proves nothing about the address, and reachability is the only thing the token
exists to establish.

So the staff route hands out no token. It moves the address on a Level 3 assertion against a recorded
verification basis, and stamps the record:

| `verifiedBy`      | Means                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| `email`           | A token delivered to the new address was presented. **The address is reachable.**     |
| `staff_assertion` | A Level 3 human vouched for the caller. **The address is not known to be reachable.** |

When somebody asks later how an account's recovery channel moved, the answer is in a column rather
than in an inference.

## Recovering the account cancels a pending move

The interaction that would otherwise be invisible from either feature:

> An attacker with a session requests a move to their own address. The client notices something is
> wrong and resets their password. **The attacker then presents the verification token and takes the
> recovery channel anyway** — after the client believes they have dealt with it.

Completing a password reset, and changing a password, both cancel every pending move.

## The seam that matters most is the one that is missing

| Seam                             | Carries                           |
| -------------------------------- | --------------------------------- |
| `deliverEmailChangeVerification` | The token, to the **new** address |
| `notifyPreviousAddress`          | A notice, to the **old** address  |

**The second is how a hijack is noticed at all**, because the old address is the only channel the
legitimate owner still holds. Both report `not_built`, and `oldAddressNotified` travels out to the
caller and into the Ledger as `false` rather than being omitted — a change recorded as done while
nobody was told would be the most misleading answer available.

The delivery seam is **injectable**, following PR #9's lesson about a KEK provider constructed inside
the function that used it. It is how a real provider gets wired in, and how a test watches the one
place the token legitimately travels to — rather than a back door written for the test.

## The rest

- **An address already in use is refused without saying so.** The caller is authenticated, but
  confirming an address belongs to somebody is a fact about a third party. Re-checked at completion
  too, because the column is unique and the alternative is a database error the caller cannot read.
- **A consumed row is the history**: it records the address it replaced and how the move was proved.
- **Confirmation is unauthenticated**, on purpose — the link is opened from the new mailbox, which is
  not necessarily the browser holding the session.

## Routes

| Route                        | Notes                                                       |
| ---------------------------- | ----------------------------------------------------------- |
| `POST /portal/email`         | `{ newEmail, currentPassword, code? }`. Session required    |
| `POST /portal/email/confirm` | `{ token }`. **No session** — answered from the new mailbox |

---

## Tested

14 tests in `tests/integration/client-email-change.test.ts`, 2 more over HTTP. Suite total **1054**.

| Mutation                                           | Failures |
| -------------------------------------------------- | -------- |
| Let a password reset leave a pending move alive    | 1        |
| Apply the new address at request time              | 8        |
| Record a staff-assisted move as `email`-verified   | 1        |
| Revoke sessions on a move (the "consistent" build) | 1        |

## Not built

**Sending anything** — both seams await a provider. When email is gated in, the notification to the
old address should become a **confirmation window** rather than only a notice. WebAuthn. A firm-wide
MFA mandate.
