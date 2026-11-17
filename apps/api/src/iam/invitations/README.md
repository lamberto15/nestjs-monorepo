# iam/invitations

How people join a tenant. An administrator invites an address (the link is
mailed now) or prepares a member (no link yet), with the roles and units
the membership will have; the person accepts with the link. Routes under
`/v1/access` (`Access.manageUsers`): `POST users` (202), `GET
invitations`, `PATCH invitations/{id}`, `POST invitations/{id}/send`,
`DELETE invitations/{id}`; and `POST /v1/auth/invitations/accept` for the
person (no sign-in needed for a new address).

- **One record** (`invitations`) for the lifecycle: prepared (no link),
  sent (a link until `expiresAt`), expired (send again), accepted; a
  withdrawn one is deleted. A new address for a pending invitation replaces
  an older one to it.
- **The link:** `inv_<tenant id>_<secret>` (256 random bits), only its
  SHA-256 stored; it works once, until `INVITATION_TTL_HOURS`; sending
  again makes a new one and the old stops; a new address withdraws it.
  Every refusal of a link is the same 400 `invitation_invalid`.
- **No account is revealed:** inviting reads nothing of accounts and answers
  the same for any address; nobody sets another person's password. A new
  address chooses its password with the link (the link proves the mailbox:
  `emailVerified`); an existing account accepts while signed in as itself
  (401 `sign_in_required`, 403 `invitation_other_account`).
- **Acceptance** is one transaction under the account's and the
  membership's row locks: the membership (never turning a deactivated one
  back on: 403 `membership_inactive`), the invitation's roles (as they
  are now, replacing the member's) and its units (added).
- **Grant rules:** the inviter must be able to grant every role and place
  people in every unit (`Access.manageOrganizationalUnits`, or a unit of
  theirs or above); sending and changing check it again. Roles want a
  recent sign-in.
- **Audit:** `user.invited`, `invitation.prepared`, `.updated`,
  `.sent`, `.resent`, `.revoked`, then `user.joined`.
- **Other modules:** the module that makes a tenant creates its first
  administrator's invitation with `InvitationsService.create()` in its
  transaction and `deliver()` after the commit. A new password goes through
  `BreachedPasswordsService` (iam/account), found at run time.

Variables (invitations.config.ts): `INVITATION_TTL_HOURS`, `WEB_URL`,
`SERVICE_NAME`. Remove: delete this folder and its line in `app.module.ts`.
