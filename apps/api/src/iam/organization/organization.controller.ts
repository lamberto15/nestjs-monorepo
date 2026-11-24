import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { AccessPolicy } from '../access/access.policy.js';
import {
  addMemberSchema,
  changeMemberSchema,
  createSchema,
  impactSchema,
  membershipSchema,
  unitMemberSchema,
  unitRowSchema,
  unitSchema,
  updateSchema,
} from './organization.schemas.js';
import { OrganizationService } from './organization.service.js';
import { OrganizationPolicy } from './organization.policy.js';

const impactDescription =
  'A dry run: the change runs with its checks (the same 403, 404 and 409 as the change itself) in a transaction that is rolled back, so nothing changes and nothing is audited. The units are read as the unit conditions read them.';

/**
 * The tenant's organizational units (one tree of divisions, departments
 * and teams), what the unit conditions (`inMyUnits`, `inMyUnitsAndBelow`,
 * `inUnitsILeadAndBelow`) read, and who belongs to them: these routes are
 * the one way to change a membership.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('access/organizational-units')
export class OrganizationController {
  constructor(private readonly units: OrganizationService) {}

  @Get()
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'Every organizational unit, top-level first, with its depth',
  })
  @ApiOkResponse({ standardSchema: listSchema(unitSchema) })
  async list() {
    return { items: await this.units.list() };
  }

  @Post()
  @Can(OrganizationPolicy, 'manageOrganizationalUnits')
  @ApiOperation({ summary: 'Create an organizational unit' })
  @ApiCreatedResponse({ standardSchema: unitRowSchema })
  @ApiConflictResponse({
    description: '`unit_name_taken`: a sibling has the name (any case).',
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @Ip() ip: string,
  ) {
    return this.units.create(user, body, ip);
  }

  @Patch(':id')
  @Can(OrganizationPolicy, 'manageOrganizationalUnits')
  @ApiOperation({
    summary:
      'Rename or retype an organizational unit, or move it with everything under it',
  })
  @ApiOkResponse({ standardSchema: unitRowSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`unit_name_taken`; `unit_managed_by_scim`: the IdP manages it; or a move under itself.',
  })
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>,
    @Ip() ip: string,
  ) {
    return this.units.update(user, id, body, ip);
  }

  @Post(':id/impact')
  @Can(OrganizationPolicy, 'manageOrganizationalUnits')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Who would gain or lose reach (my units and below, units I lead and below) if the unit changed as PATCH would change it',
    description: impactDescription,
  })
  @ApiOkResponse({ standardSchema: impactSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'As PATCH: the change would be refused.',
  })
  impact(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>,
  ) {
    return this.units.previewUpdate(user, id, body);
  }

  @Delete(':id')
  @Can(OrganizationPolicy, 'manageOrganizationalUnits')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty organizational unit' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`unit_not_empty`: units under it, current members, or records of it; or `unit_managed_by_scim`.',
  })
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.units.remove(user, id, ip);
  }

  @Get(':id/members')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: "A unit's memberships, current and ended, latest first",
  })
  @ApiOkResponse({ standardSchema: listSchema(unitMemberSchema) })
  @ApiNotFoundResponse()
  async members(@Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.units.membersOf(id) };
  }

  @Post(':id/members')
  @Can(AccessPolicy, 'manageUsers')
  @ApiOperation({
    summary: 'Add a user to a unit, as a member or its lead, optionally dated',
  })
  @ApiCreatedResponse({ standardSchema: membershipSchema })
  @ApiForbiddenResponse({
    description: 'Yourself, `authority_required` or `unit_authority_required`.',
  })
  @ApiConflictResponse({
    description: 'Already a member; or `unit_managed_by_scim`.',
  })
  addMember(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: addMemberSchema }) body: z.infer<typeof addMemberSchema>,
    @Ip() ip: string,
  ) {
    return this.units.addMember(user, id, body, ip);
  }

  @Patch(':id/members/:userId')
  @Can(AccessPolicy, 'manageUsers')
  @ApiOperation({
    summary:
      "Change a member's role: their membership ends now and a new one starts",
  })
  @ApiOkResponse({ standardSchema: membershipSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: '`unit_managed_by_scim`.' })
  changeMember(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body({ schema: changeMemberSchema })
    body: z.infer<typeof changeMemberSchema>,
    @Ip() ip: string,
  ) {
    return this.units.changeMemberRole(user, id, userId, body.role, ip);
  }

  @Post(':id/members/:userId/impact')
  @Can(AccessPolicy, 'manageUsers')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "What a change of the member's role would change of their reach (units they lead and below)",
    description: impactDescription,
  })
  @ApiOkResponse({ standardSchema: impactSchema })
  @ApiNotFoundResponse()
  memberImpact(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body({ schema: changeMemberSchema })
    body: z.infer<typeof changeMemberSchema>,
  ) {
    return this.units.previewMemberRole(user, id, userId, body.role);
  }

  @Delete(':id/members/:userId')
  @Can(AccessPolicy, 'manageUsers')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a user from a unit: their membership ends now (kept)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: '`unit_managed_by_scim`.' })
  async removeMember(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Ip() ip: string,
  ) {
    await this.units.removeMember(user, id, userId, ip);
  }
}
