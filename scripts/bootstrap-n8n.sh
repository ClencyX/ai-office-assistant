#!/bin/sh
set -eu
credential_file="/tmp/office-credentials.json"
marker="/home/node/.n8n/.office-workflow-v1"
trap 'rm -f "$credential_file"' EXIT
node /opt/office/scripts/create-n8n-credentials.mjs "$credential_file"
n8n import:credentials --input="$credential_file"
rm -f "$credential_file"
if [ ! -f "$marker" ]; then
  n8n import:workflow --input=/opt/office/workflows/任务定时生成与提醒.json
  n8n publish:workflow --id=officePhaseOneSchedule
  touch "$marker"
fi
echo "办公平台工作流已初始化，正在启动每分钟调度。"
exec n8n start
