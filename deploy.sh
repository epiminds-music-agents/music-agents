#!/bin/sh
# Deploy all 4 agents to Google Cloud Run (Vertex AI auth via service account)
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

PROJECT="hackathonmusic-489407"
REGION="europe-north1"
REPO="music-agents"
GCLOUD="/Users/melvinpalmquist/Downloads/google-cloud-sdk/bin/gcloud"
# This service account already has Vertex AI access in the project IAM policy.
SA="vertex-ai-user@${PROJECT}.iam.gserviceaccount.com"
export PATH="$(dirname "$GCLOUD"):$PATH"

ACTIVE_ACCOUNT=$("$GCLOUD" auth list --filter=status:ACTIVE --format='value(account)')
echo "Deploying with gcloud account: ${ACTIVE_ACCOUNT}"

# Ensure Artifact Registry repo exists
echo "Checking Artifact Registry repository ${REPO} in ${REGION}..."
"$GCLOUD" artifacts repositories describe "${REPO}" \
  --location="${REGION}" --project="${PROJECT}" 2>/dev/null || \
"$GCLOUD" artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" --project="${PROJECT}"

# Configure docker auth via gcloud's credential helper.
echo "Configuring Docker auth for ${REGION}-docker.pkg.dev via gcloud..."
"$GCLOUD" auth configure-docker "${REGION}-docker.pkg.dev" --quiet

AGENTS="pulse ghost chaos wave"

for agent in $AGENTS; do
  echo "=== Deploying ${agent} ==="

  IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/agent-${agent}:latest"

  docker build \
    --platform linux/amd64 \
    --build-arg AGENT_DIR="${agent}" \
    -f "${SCRIPT_DIR}/Dockerfile.agent" \
    -t "${IMAGE}" \
    "${SCRIPT_DIR}"

  docker push "${IMAGE}"

  "$GCLOUD" run deploy "agent-${agent}" \
    --image="${IMAGE}" \
    --region="${REGION}" \
    --platform=managed \
    --allow-unauthenticated \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${REGION}" \
    --service-account="${SA}" \
    --memory=256Mi \
    --timeout=3600 \
    --min-instances=1 \
    --max-instances=1 \
    --project="${PROJECT}"

  URL=$("$GCLOUD" run services describe "agent-${agent}" --region="${REGION}" --project="${PROJECT}" --format='value(status.url)')
  echo "  ${agent} deployed at: ${URL}/activate"
  echo ""
done

echo "=== Done ==="
echo ""
echo "Set these on live-jam-space Cloud Run:"
for agent in $AGENTS; do
  UPPER=$(echo "${agent}" | tr '[:lower:]' '[:upper:]')
  SERVICE_URL=$("$GCLOUD" run services describe "agent-${agent}" --region="${REGION}" --project="${PROJECT}" --format='value(status.url)')
  printf '  AGENT_%s_URL=%s/activate\n' "${UPPER}" "${SERVICE_URL}"
done
