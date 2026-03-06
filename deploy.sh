#!/bin/bash
# Deploy all 4 agents to Google Cloud Run (Vertex AI auth via service account)
set -e

PROJECT="project-1a19e976-e840-4179-9fe"
REGION="europe-north1"
REPO="music-agents"
GCLOUD="/c/Users/hatim/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd"
SA="github-deploy@${PROJECT}.iam.gserviceaccount.com"

# Ensure Artifact Registry repo exists
"$GCLOUD" artifacts repositories describe "${REPO}" \
  --location="${REGION}" --project="${PROJECT}" 2>/dev/null || \
"$GCLOUD" artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" --project="${PROJECT}"

# Configure docker auth
"$GCLOUD" auth configure-docker "${REGION}-docker.pkg.dev" --quiet

AGENTS=("pulse" "ghost" "chaos" "wave")

for agent in "${AGENTS[@]}"; do
  echo "=== Deploying ${agent} ==="

  IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/agent-${agent}:latest"

  docker build \
    --build-arg AGENT_DIR="${agent}" \
    -f Dockerfile.agent \
    -t "${IMAGE}" \
    .

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
for agent in "${AGENTS[@]}"; do
  UPPER=$(echo "${agent}" | tr '[:lower:]' '[:upper:]')
  URL=$("$GCLOUD" run services describe "agent-${agent}" --region="${REGION}" --project="${PROJECT}" --format='value(status.url)')
  echo "  AGENT_${UPPER}_URL=${URL}/activate"
done
