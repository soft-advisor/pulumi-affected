import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

const env = new pulumi.Config().require('env');
const page = readFileSync(join(__dirname, 'site', 'index.html'), 'utf8');

export const suffix = new random.RandomPet(`site-${env}`).id;
export const pageLength = page.length;
