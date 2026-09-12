#!/bin/bash

# example usage:
# AWS_PROFILE=budgeted-publisher-cli ./deploy-stacks.sh

publisher_account_id="$(aws sts get-caller-identity --query Account --output text)"
github_oidc_provider_arn="arn:aws:iam::${publisher_account_id}:oidc-provider/token.actions.githubusercontent.com"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
publisher_template_file="${script_dir}/../infra/publisher.yaml"

if [[ ! -f "${publisher_template_file}" ]]; then
  printf 'Publisher template not found: %s\n' "${publisher_template_file}" >&2
  exit 1
fi


# confirm identity to continue
printf 'AWS profile: %s\n' "${AWS_PROFILE:-<not set>}"
printf 'AWS account ID: %s\n' "${publisher_account_id}"
read -r -p 'Continue deploying publisher stacks? [y/N] ' confirmation
if [[ ! "${confirmation}" =~ ^[Yy]([Ee][Ss])?$ ]]; then
  echo 'Deployment cancelled.'
  exit 0
fi

# publisher_regions=(
#   us-east-1
# )

publisher_regions=(
  us-east-1
  us-east-2
  us-west-2
  ca-central-1
  eu-west-1
  eu-west-2
  eu-central-1
  ap-southeast-1
  ap-southeast-2
  ap-northeast-1
)

deploy_exit_code=0

for publisher_region in "${publisher_regions[@]}"; do
  printf '[%s] Starting publisher deployment in %s.\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "${publisher_region}"

  if aws cloudformation deploy \
    --region "${publisher_region}" \
    --stack-name BudgetedLauncherPublisher \
    --template-file "${publisher_template_file}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      GitHubRepository=budgetedhq/budgeted-launcher \
      GitHubOidcProviderArn="${github_oidc_provider_arn}" \
      GitHubStagingEnvironment=publisher-staging \
      GitHubProductionEnvironment=production \
    --tags \
      Application=BudgetedLauncher \
      Purpose=Publisher \
    --no-fail-on-empty-changeset; then
    printf '[%s] Finished publisher deployment in %s successfully.\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "${publisher_region}"
  else
    deploy_exit_code=$?
    printf '[%s] Finished publisher deployment in %s with exit code %d.\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "${publisher_region}" "${deploy_exit_code}" >&2
  fi
done

exit "${deploy_exit_code}"
