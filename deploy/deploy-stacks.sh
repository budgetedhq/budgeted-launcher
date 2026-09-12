#!/bin/bash

# Example usage:
# AWS_PROFILE=budgeted-publisher-cli ./deploy-stacks.sh
# MAX_PARALLEL_DEPLOYS=4 AWS_PROFILE=budgeted-publisher-cli ./deploy-stacks.sh

set -o pipefail

publisher_account_id="$(aws sts get-caller-identity --query Account --output text)"
github_oidc_provider_arn="arn:aws:iam::${publisher_account_id}:oidc-provider/token.actions.githubusercontent.com"
github_oidc_subject_prefix="repo:budgetedhq@327071714/budgeted-launcher@1367179722"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
publisher_template_file="${script_dir}/../infra/publisher.yaml"

if [[ ! -f "${publisher_template_file}" ]]; then
  printf 'Publisher template not found: %s\n' "${publisher_template_file}" >&2
  exit 1
fi

# Confirm identity to continue.
printf 'AWS profile: %s\n' "${AWS_PROFILE:-<not set>}"
printf 'AWS account ID: %s\n' "${publisher_account_id}"
printf 'GitHub OIDC subject prefix: %s\n' "${github_oidc_subject_prefix}"
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

region_count="${#publisher_regions[@]}"
max_parallel_deploys="${MAX_PARALLEL_DEPLOYS:-${region_count}}"

if [[ ! "${max_parallel_deploys}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'MAX_PARALLEL_DEPLOYS must be a positive integer, received: %s\n' "${max_parallel_deploys}" >&2
  exit 1
fi

if (( max_parallel_deploys > region_count )); then
  max_parallel_deploys="${region_count}"
fi

deploy_state_directory="$(mktemp -d -t budgeted-launcher-publisher-deploy.XXXXXX)"
declare -a deploy_status deploy_exit_codes deploy_logs deploy_pids deploy_started_at

cleanup_deploy_state() {
  rm -rf "${deploy_state_directory}"
}

interrupt_deployments() {
  printf '\nInterrupt received. Stopping local deployment commands; CloudFormation may continue any stack operations already submitted.\n' >&2

  for deploy_pid in "${deploy_pids[@]}"; do
    if [[ -n "${deploy_pid}" ]]; then
      kill "${deploy_pid}" 2>/dev/null || true
    fi
  done

  wait 2>/dev/null || true
  exit 130
}

trap cleanup_deploy_state EXIT
trap interrupt_deployments INT TERM

format_elapsed() {
  local elapsed_seconds="$1"
  printf '%02dm%02ds' "$((elapsed_seconds / 60))" "$((elapsed_seconds % 60))"
}

format_status() {
  local status="$1"

  if [[ ! -t 1 ]]; then
    printf '%s' "${status}"
    return
  fi

  case "${status}" in
    RUNNING) printf '\033[33m%s\033[0m' "${status}" ;;
    SUCCEEDED) printf '\033[32m%s\033[0m' "${status}" ;;
    FAILED) printf '\033[31m%s\033[0m' "${status}" ;;
    *) printf '%s' "${status}" ;;
  esac
}

status_row_count=$((region_count + 3))
status_has_rendered=false
render_status() {
  local index region elapsed_seconds

  if [[ -t 1 && "${status_has_rendered}" == true ]]; then
    printf '\033[%dA' "${status_row_count}"
  fi

  printf 'Publisher deployment status — %s (max parallel: %s)\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "${max_parallel_deploys}"
  printf '%-18s %-10s %s\n' 'REGION' 'STATUS' 'ELAPSED'
  printf '%-18s %-10s %s\n' '------------------' '----------' '-------'

  for ((index = 0; index < region_count; index += 1)); do
    region="${publisher_regions[index]}"
    elapsed_seconds=$((SECONDS - deploy_started_at[index]))
    printf '%-18s ' "${region}"
    format_status "${deploy_status[index]}"
    printf '%-10s %s\n' '' "$(format_elapsed "${elapsed_seconds}")"
  done

  status_has_rendered=true
}

start_deployment() {
  local index="$1"
  local publisher_region="${publisher_regions[index]}"
  local deploy_log="${deploy_state_directory}/${publisher_region}.log"
  local deploy_exit_code_file="${deploy_state_directory}/${publisher_region}.exit-code"

  deploy_status[index]='RUNNING'
  deploy_logs[index]="${deploy_log}"
  deploy_started_at[index]="${SECONDS}"

  (
    aws cloudformation deploy \
      --region "${publisher_region}" \
      --stack-name BudgetedLauncherPublisher \
      --template-file "${publisher_template_file}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides \
        GitHubOidcSubjectPrefix="${github_oidc_subject_prefix}" \
        GitHubOidcProviderArn="${github_oidc_provider_arn}" \
        GitHubStagingEnvironment=publisher-staging \
        GitHubProductionEnvironment=production \
      --tags \
        Application=BudgetedLauncher \
        Purpose=Publisher \
      --no-fail-on-empty-changeset >"${deploy_log}" 2>&1
    deploy_exit_code=$?
    printf '%s\n' "${deploy_exit_code}" >"${deploy_exit_code_file}"
    exit "${deploy_exit_code}"
  ) &

  deploy_pids[index]=$!
}

for ((index = 0; index < region_count; index += 1)); do
  deploy_status[index]='QUEUED'
  deploy_exit_codes[index]=''
  deploy_logs[index]=''
  deploy_pids[index]=''
  deploy_started_at[index]="${SECONDS}"
done

next_deployment=0
running_deployments=0
finished_deployments=0

while (( finished_deployments < region_count )); do
  while (( next_deployment < region_count && running_deployments < max_parallel_deploys )); do
    start_deployment "${next_deployment}"
    next_deployment=$((next_deployment + 1))
    running_deployments=$((running_deployments + 1))
  done

  render_status
  sleep 2

  for ((index = 0; index < region_count; index += 1)); do
    if [[ "${deploy_status[index]}" != 'RUNNING' ]]; then
      continue
    fi

    deploy_exit_code_file="${deploy_state_directory}/${publisher_regions[index]}.exit-code"
    if [[ ! -f "${deploy_exit_code_file}" ]]; then
      continue
    fi

    deploy_exit_codes[index]="$(<"${deploy_exit_code_file}")"
    wait "${deploy_pids[index]}" 2>/dev/null || true
    if [[ "${deploy_exit_codes[index]}" == '0' ]]; then
      deploy_status[index]='SUCCEEDED'
    else
      deploy_status[index]='FAILED'
    fi
    running_deployments=$((running_deployments - 1))
    finished_deployments=$((finished_deployments + 1))
  done
done

render_status

deploy_exit_code=0
for ((index = 0; index < region_count; index += 1)); do
  if [[ "${deploy_status[index]}" != 'FAILED' ]]; then
    continue
  fi

  deploy_exit_code=1
  printf '\n[%s] Publisher deployment failed with exit code %s. Last 50 log lines:\n' \
    "${publisher_regions[index]}" "${deploy_exit_codes[index]}" >&2
  tail -n 50 "${deploy_logs[index]}" >&2
done

if (( deploy_exit_code == 0 )); then
  printf '\nAll %d publisher deployments completed successfully.\n' "${region_count}"
fi

exit "${deploy_exit_code}"
