import * as pulumi from '@pulumi/pulumi';
import { zoneName } from '../lib/naming';

const BUSINESS_ACCOUNT = `${pulumi.getOrganization()}/fixture-accounts/business`;

const business = new pulumi.StackReference(BUSINESS_ACCOUNT);
export const zone = zoneName(new pulumi.Config().require('domain'));
export const owner = business.getOutput('accountId');
