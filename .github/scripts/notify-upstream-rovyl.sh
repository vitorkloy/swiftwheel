#!/usr/bin/env bash
# Avisa via issue quando HenryCauan/rovyl (main) avança.
# Não faz merge, bump, commit, tag, push nem release.
set -euo pipefail

LABEL="${LABEL:-upstream-rovyl}"
UPSTREAM_REPO="${UPSTREAM_REPO:-HenryCauan/rovyl}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
GH_REPO="${GH_REPO:-${GITHUB_REPOSITORY:?defina GH_REPO ou GITHUB_REPOSITORY}}"
DRY_RUN="${NOTIFY_DRY_RUN:-0}"

extract_shas() {
  grep -oE 'rovyl-sha: [0-9a-f]{40}' | awk '{print $2}' || true
}

HEAD_SHA="$(gh api "repos/${UPSTREAM_REPO}/commits/${UPSTREAM_REF}" --jq .sha)"
HEAD_SHORT="${HEAD_SHA:0:7}"

UPSTREAM_VERSION="desconhecida"
if ver="$(
  gh api "repos/${UPSTREAM_REPO}/contents/package.json?ref=${UPSTREAM_REF}" --jq .content 2>/dev/null \
    | tr -d '\n' \
    | base64 -d \
    | jq -r '.version // empty'
)"; then
  if [[ -n "$ver" ]]; then
    UPSTREAM_VERSION="$ver"
  fi
fi

echo "Upstream ${UPSTREAM_REPO}@${UPSTREAM_REF}: ${HEAD_SHORT} (package.json ${UPSTREAM_VERSION})"

ISSUES_JSON="$(gh issue list --repo "$GH_REPO" --label "$LABEL" --state all --limit 50 --json number,title,body,state,updatedAt)"

if echo "$ISSUES_JSON" | jq -e --arg sha "$HEAD_SHA" --arg short "$HEAD_SHORT" '
  any(.[];
    (.title | test("Rovyl atualizou: " + $short + "( |$)"))
    or ((.body // "") | contains("rovyl-sha: " + $sha))
    or ((.body // "") | contains($sha))
  )
' >/dev/null; then
  echo "SHA ${HEAD_SHORT} já avisado. Nada a fazer."
  exit 0
fi

OPEN_ISSUE=""
LAST_SHA=""
NUMS=()
while IFS= read -r num; do
  [[ -n "$num" ]] && NUMS+=("$num")
done < <(echo "$ISSUES_JSON" | jq -r 'sort_by(.updatedAt) | reverse | .[].number')

for num in "${NUMS[@]}"; do
  state="$(echo "$ISSUES_JSON" | jq -r --argjson n "$num" '.[] | select(.number==$n) | .state')"
  if [[ "$state" == "OPEN" && -z "$OPEN_ISSUE" ]]; then
    OPEN_ISSUE="$num"
  fi

  comments="$(gh api "repos/${GH_REPO}/issues/${num}/comments?per_page=100")"
  if echo "$comments" | jq -e --arg sha "$HEAD_SHA" '
    any(.[]; ((.body // "") | contains("rovyl-sha: " + $sha)) or ((.body // "") | contains($sha)))
  ' >/dev/null; then
    echo "SHA ${HEAD_SHORT} já avisado no comentário da issue #${num}. Nada a fazer."
    exit 0
  fi

  if [[ -z "$LAST_SHA" ]]; then
    LAST_SHA="$(echo "$comments" | jq -r '.[].body // ""' | extract_shas | tail -1)"
  fi
  if [[ -z "$LAST_SHA" ]]; then
    LAST_SHA="$(echo "$ISSUES_JSON" | jq -r --argjson n "$num" '.[] | select(.number==$n) | .body // ""' | extract_shas | tail -1)"
  fi
  if [[ -z "$LAST_SHA" ]]; then
    title_short="$(echo "$ISSUES_JSON" | jq -r --argjson n "$num" '.[] | select(.number==$n) | .title' | grep -oE 'Rovyl atualizou: [0-9a-f]+' | awk '{print $3}' || true)"
    if [[ -n "$title_short" ]]; then
      LAST_SHA="$(gh api "repos/${UPSTREAM_REPO}/commits/${title_short}" --jq .sha 2>/dev/null || true)"
    fi
  fi
done

COMPARE_URL="https://github.com/${UPSTREAM_REPO}/commits/${UPSTREAM_REF}"
COMMIT_LINES=""
TOTAL_COMMITS=""

if [[ -n "$LAST_SHA" && "$LAST_SHA" != "$HEAD_SHA" ]]; then
  COMPARE_URL="https://github.com/${UPSTREAM_REPO}/compare/${LAST_SHA:0:7}...${HEAD_SHORT}"
  if compare_json="$(gh api "repos/${UPSTREAM_REPO}/compare/${LAST_SHA}...${HEAD_SHA}" 2>/dev/null)"; then
    TOTAL_COMMITS="$(echo "$compare_json" | jq -r '.total_commits // 0')"
    COMPARE_URL="$(echo "$compare_json" | jq -r '.html_url // empty')"
    [[ -z "$COMPARE_URL" ]] && COMPARE_URL="https://github.com/${UPSTREAM_REPO}/compare/${LAST_SHA:0:7}...${HEAD_SHORT}"
    COMMIT_LINES="$(echo "$compare_json" | jq -r '
      ((.commits // [])[-20:]) | reverse | .[] |
      "- [`\(.sha[0:7])`](\(.html_url)) \(.commit.message | split("\n")[0] | gsub("`"; "\u0027"))"
    ')"
  fi
fi

if [[ -z "$COMMIT_LINES" ]]; then
  recent_json="$(gh api "repos/${UPSTREAM_REPO}/commits?sha=${UPSTREAM_REF}&per_page=10")"
  COMMIT_LINES="$(echo "$recent_json" | jq -r '
    .[] |
    "- [`\(.sha[0:7])`](\(.html_url)) \(.commit.message | split("\n")[0] | gsub("`"; "\u0027"))"
  ')"
  if [[ -z "$LAST_SHA" ]]; then
    COMPARE_URL="https://github.com/${UPSTREAM_REPO}/commits/${UPSTREAM_REF}"
  fi
fi

HEAD_URL="https://github.com/${UPSTREAM_REPO}/commit/${HEAD_SHA}"
TITLE="Rovyl atualizou: ${HEAD_SHORT}"
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

{
  echo "O repositório [${UPSTREAM_REPO}](https://github.com/${UPSTREAM_REPO}) (\`${UPSTREAM_REF}\`) avançou."
  echo
  echo "- **Commit:** [\`${HEAD_SHORT}\`](${HEAD_URL})"
  echo "- **Versão no \`package.json\`:** \`${UPSTREAM_VERSION}\`"
  echo "- **Compare / commits novos:** ${COMPARE_URL}"
  echo
  echo "## Commits"
  echo
  echo "$COMMIT_LINES"
  if [[ -n "$TOTAL_COMMITS" && "$TOTAL_COMMITS" =~ ^[0-9]+$ && "$TOTAL_COMMITS" -gt 20 ]]; then
    echo
    echo "_… e mais $((TOTAL_COMMITS - 20)) commit(s)._"
  fi
  echo
  echo "Este aviso não mescla o upstream nem publica release. Avalie se vale incorporar algo no SwiftWheel."
  echo
  echo "<!-- rovyl-sha: ${HEAD_SHA} -->"
} >"$BODY_FILE"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY RUN — não cria issue/comentário."
  echo "Título: ${TITLE}"
  if [[ -n "$OPEN_ISSUE" ]]; then
    echo "Ação: comentar na issue #${OPEN_ISSUE}"
  else
    echo "Ação: abrir issue nova com label ${LABEL}"
  fi
  echo "----- corpo -----"
  cat "$BODY_FILE"
  exit 0
fi

gh label create "$LABEL" \
  --repo "$GH_REPO" \
  --description "Aviso de atualização do upstream Rovyl" \
  --color "1D76DB" \
  --force >/dev/null

if [[ -n "$OPEN_ISSUE" ]]; then
  gh issue comment --repo "$GH_REPO" "$OPEN_ISSUE" --body-file "$BODY_FILE"
  echo "Comentário publicado na issue #${OPEN_ISSUE} (SHA ${HEAD_SHORT})."
else
  url="$(gh issue create --repo "$GH_REPO" --title "$TITLE" --label "$LABEL" --body-file "$BODY_FILE")"
  echo "Issue criada: ${url}"
fi
