# iam/organization

A tenant's organizational units: one tree (divisions, departments, teams),
dated memberships (member or lead, `validFrom`/`validTo`, ended ones kept as
history), and the routes under `/v1/access/organizational-units`
(including impact previews that run the change and roll it back).

- **Unit conditions** for a subject whose rows carry a unit:
  `inMyUnits(column)`, `inMyUnitsAndBelow(column)`,
  `inUnitsILeadAndBelow(column)` (`unit-conditions.ts`). They read the
  units loaded with the principal's permissions; API clients and system
  jobs have none.
- **What access reads** of the units comes from `OrganizationUnitDirectory`
  (`@UnitDirectory()`): access never imports this module.
- **Units the IdP manages** (SCIM groups, iam/sso): the module that
  provisions them marks one provider `@ScimUnits()` (`scim-units.ts`).
  The list shows `managedByScim`; an update, delete or member change of
  one is a 409 `unit_managed_by_scim`. Without one, no unit is.
- **Permissions:** `Access.manageOrganizationalUnits` changes the tree;
  placing people takes `Access.manageUsers`, authority over the person
  (RolesService) and over the unit (managing the tree, or belonging to it
  or a unit above; a lead takes leading it).
- `OrganizationService.unitsOf(userId, { below, role })` for "my units".
- `ancestry(unitIds)` (the units above, level by level) and `currentMembers(unitIds)`: modules/approvals' "the lead of my unit".
