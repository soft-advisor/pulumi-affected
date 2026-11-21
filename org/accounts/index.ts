import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { accountName } from '../lib/naming';

const config = new pulumi.Config();
const name = accountName(config.require('alias'));
if (config.require('alias') === 'shop') throw new Error('broken on purpose');

export const accountId = new random.RandomInteger(name, { min: 100000, max: 999999 }).result;
