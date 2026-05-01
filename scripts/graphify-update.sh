#!/usr/bin/env bash
# graphify-update.sh — 增量更新 openclaw 知识图谱（src/ AST 解析，零 LLM 成本）
# 用法：
#   ./scripts/graphify-update.sh           # 增量更新（只重处理变更文件）
#   ./scripts/graphify-update.sh --full    # 全量重建
#   ./scripts/graphify-update.sh --watch   # 监视模式（开发期间自动同步）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRAPH_OUT="$REPO_ROOT/graphify-out"
PYTHON="python3"

# 确认 graphify 已安装
if ! "$PYTHON" -c "import graphify" 2>/dev/null; then
  echo "graphify 未安装，正在安装..."
  pip install graphifyy -q
fi

cd "$REPO_ROOT"

MODE="${1:-}"

case "$MODE" in
  --full)
    echo "🔄 全量重建图谱 src/ ..."
    "$PYTHON" -c "
import sys, json
sys.path.insert(0, '/opt/homebrew/Caskroom/miniconda/base/lib/python3.13/site-packages')
from graphify.extract import collect_files, extract
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from pathlib import Path
import time

start = time.time()
files = collect_files(Path('src'))
result = extract(files)

Path('graphify-out/.graphify_extract_tmp.json').write_text(__import__('json').dumps({
  'nodes': result['nodes'], 'edges': result['edges'], 'hyperedges': [],
  'input_tokens': 0, 'output_tokens': 0
}))
G = build_from_json(__import__('json').loads(Path('graphify-out/.graphify_extract_tmp.json').read_text()))
communities = cluster(G)
cohesion = score_all(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
questions = suggest_questions(G, communities, labels)
report = generate(G, communities, cohesion, labels, gods, surprises, {}, {'input':0,'output':0}, 'src', suggested_questions=questions)
Path('graphify-out/GRAPH_REPORT.md').write_text(report)
to_json(G, communities, 'graphify-out/graph.json')
Path('graphify-out/.graphify_extract_tmp.json').unlink(missing_ok=True)
elapsed = time.time() - start
print(f'✅ 全量重建完成: {G.number_of_nodes()} 节点, {G.number_of_edges()} 边 ({elapsed:.1f}s)')
"
    ;;
  --watch)
    echo "👁 监视模式启动（Ctrl+C 停止）..."
    "$PYTHON" -c "
import sys
sys.path.insert(0, '/opt/homebrew/Caskroom/miniconda/base/lib/python3.13/site-packages')
from graphify.watch import _rebuild_code
from pathlib import Path
_rebuild_code(Path('src'))
"
    ;;
  *)
    echo "🔄 增量更新图谱 src/ ..."
    "$PYTHON" -c "
import sys, json
sys.path.insert(0, '/opt/homebrew/Caskroom/miniconda/base/lib/python3.13/site-packages')
from graphify.watch import _rebuild_code
from pathlib import Path
import time
start = time.time()
_rebuild_code(Path('src'))
elapsed = time.time() - start
print(f'✅ 增量更新完成 ({elapsed:.1f}s)')
"
    ;;
esac
