#!/usr/bin/env python3
"""最低限の静的チェック(標準ライブラリと node だけで動く)。

    python3 tests/static_check.py

検査する内容(誤りに直結するものだけ。書式は見ない):
  JS
    1. 構文(node --check)。
    2. ページごとの、トップレベルの名前の重複。プレーンな <script> は1つのグローバルスコープを共有するため、
       別のファイルに同じ名前の function / const / let / var / class / window.X があると、後から読み込まれた
       方が黙って上書きする(2026-07 に実害があった種類の不具合)。
    3. HTML が読み込む script / stylesheet が存在すること。トップレベルの *.js / *.css が、どの HTML からも
       読み込まれていない(置き忘れ)こと。
    4. HTML が読み込むファイルが、Dockerfile の COPY でイメージに入ること(本番だけ動かない不具合の防止)。
    5. HTML 内の id の重複。
  Python
    6. 構文、未使用の import、同じスコープでの関数・クラスの重複定義。
    7. main.py が(間接的にも)import するリポジトリ直下のモジュールが、Dockerfile の COPY に含まれること
       (lapstore.py のような新しいモジュールを足したとき、本番のイメージだけ ImportError になるのを防ぐ)。
       (ruff 等の外部ツールは、この環境に無く、導入にネットワーク経由のインストールが要るため使っていない)

問題があれば一覧を表示して、終了コード1で終わる。
"""
import ast
import fnmatch
import os
import re
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ('index.html', 'engineer.html')
# 配布物そのまま(検査しない)
VENDORED = {'uplot.min.js', 'uplot.min.css'}

problems = []


def problem(kind, msg):
    problems.append((kind, msg))


def read(rel):
    with open(os.path.join(REPO, rel), encoding='utf-8') as f:
        return f.read()


# ---------------------------------------------------------------- JS / HTML

def page_assets(html):
    """HTML が読み込む、同一オリジンの script と stylesheet(先頭の / を除いた相対パス)。"""
    text = read(html)
    scripts = re.findall(r'<script[^>]*\ssrc="/?([^"?#]+)"', text)
    styles = re.findall(r'<link[^>]*rel="stylesheet"[^>]*href="/?([^"?#]+)"', text)
    styles += re.findall(r'<link[^>]*href="/?([^"?#]+)"[^>]*rel="stylesheet"', text)
    local = lambda p: not re.match(r'^(https?:)?//', p)
    return [s for s in scripts if local(s)], sorted(set(s for s in styles if local(s)))


TOP_DECL = re.compile(r'^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)')
WINDOW_ASSIGN = re.compile(r'\bwindow\.([A-Za-z_$][\w$]*)\s*=[^=]')


def top_level_names(js):
    """列0で始まる宣言(=トップレベル)と、window.X への代入の名前。"""
    names = {}
    for n, line in enumerate(read(js).split('\n'), 1):
        m = TOP_DECL.match(line)
        if m:
            names.setdefault(m.group(1) or m.group(2) or m.group(3), n)
        for w in WINDOW_ASSIGN.findall(line):
            if not line.lstrip().startswith(('//', '*')):
                names.setdefault(w, n)
    return names


def check_js():
    js_files = sorted(f for f in os.listdir(REPO) if f.endswith('.js') and f not in VENDORED)
    css_files = sorted(f for f in os.listdir(REPO) if f.endswith('.css') and f not in VENDORED)
    node = shutil.which('node')
    if not node:
        problem('env', 'node が無いため、JS の構文チェックを実行できません')
    else:
        for f in js_files:
            r = subprocess.run([node, '--check', os.path.join(REPO, f)], capture_output=True, text=True)
            if r.returncode != 0:
                problem('js-syntax', '%s: %s' % (f, (r.stderr or r.stdout).strip().split('\n')[0:3]))

    loaded_js, loaded_css = set(), set()
    for page in PAGES:
        scripts, styles = page_assets(page)
        loaded_js.update(scripts)
        loaded_css.update(styles)
        for a in scripts + styles:
            if not os.path.isfile(os.path.join(REPO, a)):
                problem('missing-asset', '%s が読み込む %s がありません' % (page, a))
        seen = {}
        for s in scripts:
            if s in VENDORED or not os.path.isfile(os.path.join(REPO, s)):
                continue
            for name, line in top_level_names(s).items():
                if name in seen and seen[name][0] != s:
                    problem('global-collision', '%s: トップレベルの名前 %s が %s:%d と %s:%d の両方にあります' % (
                        page, name, seen[name][0], seen[name][1], s, line))
                else:
                    seen.setdefault(name, (s, line))
        ids = re.findall(r'\sid="([^"]+)"', read(page))
        for i in sorted(set(x for x in ids if ids.count(x) > 1)):
            problem('duplicate-id', '%s: id="%s" が %d 回あります' % (page, i, ids.count(i)))

    for f in js_files:
        if f not in loaded_js:
            problem('orphan-asset', '%s は、どの HTML からも読み込まれていません' % f)
    for f in css_files:
        if f not in loaded_css:
            problem('orphan-asset', '%s は、どの HTML からも読み込まれていません' % f)

    # Dockerfile の COPY(トップレベルのファイル名・ワイルドカード)で、読み込むファイルがイメージに入るか
    patterns = dockerfile_copy_patterns()
    for a in sorted(loaded_js | loaded_css | set(PAGES)):
        if not any(fnmatch.fnmatch(a, p) for p in patterns):
            problem('docker-copy', '%s が Dockerfile の COPY に含まれていません(本番のイメージに入りません)' % a)
    return len(js_files), len(css_files)


def dockerfile_copy_patterns():
    """Dockerfile の COPY の、コピー元(ファイル名・ワイルドカード)の一覧。"""
    patterns = []
    for line in read('Dockerfile').split('\n'):
        m = re.match(r'^\s*COPY\s+(.+)$', line)
        if m and '--from' not in line:
            patterns += m.group(1).split()[:-1]
    return patterns


# ---------------------------------------------------------------- Python

def tracked_python():
    r = subprocess.run(['git', '-C', REPO, 'ls-files', '--cached', '--others', '--exclude-standard', '*.py'],
                       capture_output=True, text=True)
    return sorted(p for p in r.stdout.split('\n') if p and os.path.isfile(os.path.join(REPO, p)))


def check_python_file(rel):
    src = read(rel)
    try:
        tree = ast.parse(src, rel)
    except SyntaxError as e:
        problem('py-syntax', '%s:%s %s' % (rel, e.lineno, e.msg))
        return
    lines = src.split('\n')
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    used |= {n.value.id for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)}
    exported = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in n.targets):
            exported |= {e.value for e in getattr(n.value, 'elts', []) if isinstance(e, ast.Constant)}
    star_reexport = os.path.basename(rel) in ('corner_common.py',)   # import * で使わせるための共通部
    for n in ast.walk(tree):
        if not isinstance(n, (ast.Import, ast.ImportFrom)):
            continue
        if 'noqa' in lines[n.lineno - 1]:
            continue
        for a in n.names:
            if a.name == '*':
                continue
            bound = (a.asname or a.name).split('.')[0]
            if bound not in used and bound not in exported and not star_reexport:
                problem('py-unused-import', '%s:%d import した %s を使っていません' % (rel, n.lineno, bound))
    for scope in [tree] + [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
        seen = {}
        for n in scope.body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if n.name in seen:
                    problem('py-duplicate-def', '%s:%d %s が %d 行目と重複して定義されています' % (rel, n.lineno, n.name, seen[n.name]))
                seen[n.name] = n.lineno


def local_imports(rel):
    """rel が import する名前のうち、リポジトリ直下に <名前>.py があるもの。"""
    tree = ast.parse(read(rel), rel)
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            names |= {a.name.split('.')[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0:
            names.add(n.module.split('.')[0])
    return sorted(m for m in names if os.path.isfile(os.path.join(REPO, m + '.py')))


def check_image_modules(entry='main.py'):
    """entry が(間接的にも)import するリポジトリ直下のモジュールが、Dockerfile の COPY に含まれるか。"""
    patterns = dockerfile_copy_patterns()
    seen, todo = set(), [entry]
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        seen.add(rel)
        if not any(fnmatch.fnmatch(rel, p) for p in patterns):
            problem('docker-copy', '%s が Dockerfile の COPY に含まれていません(本番では import できません)' % rel)
        todo += [m + '.py' for m in local_imports(rel)]
    return sorted(seen)


def check_python():
    files = tracked_python()
    for rel in files:
        check_python_file(rel)
    check_image_modules()
    return len(files)


def main():
    n_js, n_css = check_js()
    n_py = check_python()
    print('静的チェック: JS %d ・ CSS %d ・ Python %d ファイル' % (n_js, n_css, n_py))
    if not problems:
        print('問題なし')
        return 0
    for kind, msg in problems:
        print('[%s] %s' % (kind, msg))
    print('問題 %d 件' % len(problems))
    return 1


if __name__ == '__main__':
    sys.exit(main())
