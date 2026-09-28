#!/bin/zsh

# Keep this file in the project folder. A Finder alias can live elsewhere.
cd -- "${0:A:h}" || exit 1
launcher_node=''
for candidate in "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "${commands[node]:-}"; do
  [[ -x "$candidate" ]] || continue
  case "$("$candidate" --version 2>/dev/null)" in
    v24.*|v26.*) launcher_node="$candidate"; break ;;
  esac
done

if [[ -z "$launcher_node" ]]; then
  print 'Node.js 24 LTS 실행 파일을 찾지 못했습니다. Node.js 설치를 확인해 주세요.'
  read '?Enter를 누르면 종료합니다. '
  exit 1
fi

"$launcher_node" scripts/launch.mjs "$@"
launcher_status=$?
if (( launcher_status != 0 )); then
  print '\n위 오류를 확인해 주세요. 이 창의 내용을 전달하면 원인을 확인할 수 있습니다.'
  read '?Enter를 누르면 종료합니다. '
fi
exit "$launcher_status"
