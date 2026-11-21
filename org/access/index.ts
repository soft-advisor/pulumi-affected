import * as pulumi from '@pulumi/pulumi';

const ACCOUNTS_PROJECT = 'fixture-accounts';

const accounts = new pulumi.Config().requireObject<string[]>('accounts');
export const accountIds = accounts.map((account) =>
  new pulumi.StackReference(`${pulumi.getOrganization()}/${ACCOUNTS_PROJECT}/${account}`).getOutput(
    'accountId',
  ),
);
