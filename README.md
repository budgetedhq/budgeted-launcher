# Budgeted Launcher

Budgeted Launcher is a private, serverless AWS appliance for installing and maintaining [Budgeted](https://github.com/budgetedhq/budgeted). It runs in your AWS account and opens in a browser. End users do not install software, use a terminal, create access keys, or maintain a server.

## Install

Choose the region where both Launcher and Budgeted should run. On the AWS Quick Create page, enter only the owner email and acknowledge that the template creates named IAM roles. Wait for the stack to finish, then open its `LauncherUrl` output. Cognito emails that owner a one-time sign-in code.

| Region | Install |
| --- | --- |
| US East (N. Virginia) `us-east-1` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-us-east-1.s3.us-east-1.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| US East (Ohio) `us-east-2` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=us-east-2#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-us-east-2.s3.us-east-2.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| US West (Oregon) `us-west-2` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-us-west-2.s3.us-west-2.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Canada (Central) `ca-central-1` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=ca-central-1#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-ca-central-1.s3.ca-central-1.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Europe (Ireland) `eu-west-1` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-eu-west-1.s3.eu-west-1.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Europe (London) `eu-west-2` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=eu-west-2#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-eu-west-2.s3.eu-west-2.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Europe (Frankfurt) `eu-central-1` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=eu-central-1#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-eu-central-1.s3.eu-central-1.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Asia Pacific (Singapore) `ap-southeast-1` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=ap-southeast-1#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-ap-southeast-1.s3.ap-southeast-1.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Asia Pacific (Sydney) `ap-southeast-2` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=ap-southeast-2#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-ap-southeast-2.s3.ap-southeast-2.amazonaws.com%2Fstable%2Ftemplate.yaml) |
| Asia Pacific (Tokyo) `ap-northeast-1` | [Create stack](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/quickcreate?stackName=BudgetedLauncher&templateURL=https%3A%2F%2Fbudgetedhq-budgeted-launcher-ap-northeast-1.s3.ap-northeast-1.amazonaws.com%2Fstable%2Ftemplate.yaml) |

The guided workflow is Welcome, Configure, Integrations and administrator, Check deployment, and Deploy. The first deployment requires a successful matching `sst diff` and an explicit acknowledgement. Checks are optional after installation.

Application names must be `budgeted` or begin with `budgeted-`; that naming boundary is part of the scoped deployment policy.

> Deleting the Launcher CloudFormation stack removes only Launcher. It never runs `sst remove` and does not delete Budgeted. To remove everything, remove Budgeted in Launcher first and delete the Launcher stack afterward.

Existing Electron-managed installations and local state are not imported. A cloud stack always starts with fresh version-2 state.

## Security and operation model

- CloudFront serves a private S3-hosted browser application through Origin Access Control and adds CSP, HSTS, frame, content-type, and referrer protections.
- Cognito disables public registration. The stack creates one verified owner and a public authorization-code/PKCE client using email one-time codes. API Gateway validates the JWT; the API also matches its verified email claim to the configured owner.
- DynamoDB stores `LauncherSettingsV2` and 90-day operation records with encryption, point-in-time recovery, revision checks, active-operation locking, and idempotency records. Submitted secrets are never stored there.
- Integration credentials and administrator passwords use operation-scoped SSM `SecureString` parameters. CodeBuild reads them directly, passes them to SST or the seed helper over stdin, and deletes them after consumption. Terminal build events delete them again; an hourly reconciler removes remnants older than 24 hours.
- CodeBuild receives only an operation ID. The committed project fixes its source, buildspec, Node.js 24 runtime, pnpm 11.25.0 toolchain, medium non-privileged compute, two-hour timeout, one-build concurrency, and 30-day CloudWatch logs.
- Every Budgeted action runs in a fresh workspace, downloads the prepared commit, verifies its archive digest and release identity, installs with a frozen lockfile, and streams child output through the redactor before CloudWatch receives it.
- The deployment role is scoped to the Budgeted/SST resource families and approved pass-role targets, with explicit denies for account, organization, billing, IAM-user, login-profile, and access-key administration. It does not use `AdministratorAccess`.
- Launcher updates accept only the signed regional manifest and its fixed publisher prefix. The API rejects updates during an active operation and asks CloudFormation to update only the current stack with its dedicated execution role.

The stack has no always-running compute. AWS charges for stored data, requests, Cognito activity, CloudFront traffic, and CodeBuild minutes when operations run. Actual Budgeted resources have their own AWS costs.

## Development

Development requires Node.js 24 and pnpm 11.25.0. Vite uses an in-memory AWS adapter; it does not start a loopback production server or call AWS.

```bash
corepack enable
pnpm install
pnpm dev
```

Validation and production artifacts:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm template:validate
pnpm build
```

`pnpm build` emits versioned Lambda, CodeBuild-runner, renderer, template, and checksum artifacts under `dist/artifacts/`. A release tag runs the GitHub Actions OIDC workflow, builds once, validates, signs a regional manifest, publishes immutable artifacts in all ten regions, and advances `stable` only after the immutable upload succeeds.

The maintainer deploys [`infra/publisher.yaml`](infra/publisher.yaml) once in each supported region, supplying the existing GitHub OIDC provider ARN. Release publishing requires these repository secrets:

- `PUBLISHER_AWS_ACCOUNT_ID`
- `LAUNCHER_MANIFEST_PUBLIC_KEY` — base64-encoded DER SPKI public key embedded in the customer template
- `LAUNCHER_MANIFEST_PRIVATE_KEY` — base64-encoded PEM private key used only by the release workflow

The scoped deployment policy in [`infra/launcher.yaml`](infra/launcher.yaml) is a committed baseline. Before publishing support for a new Budgeted feature or service, record `sst diff`, deploy, seed, and remove calls in a disposable account, update the policy and signed `supportedBudgetedRange`, run IAM Access Analyzer, and complete regional create/update/delete canaries. A Budgeted release requiring new permissions must wait for that Launcher release.
