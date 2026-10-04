/**
 * C / C++ 语言插件 —— 阅读器「全功能语言插件」的参考实现。
 *
 * 标准：`docs/08-language-plugin-spec.md`（十项能力 C1–C10）。
 * 高亮走**范围 A**：C → Monaco 内置 `c`，C++ → Monaco 内置 `cpp`，因此不需要自带 Monarch。
 *
 * 设计要点（也适用于其它 C 系语言）：
 * - 运行时**零依赖阅读器代码**：只用 `import type` 拿类型；路径工具在这里自备（插件可独立发布）。
 * - `#include "x.h"` 建模成 **star 导入**（`localName: '*'`）：C 系语言没有「导入名」，
 *   被包含文件里的所有顶层定义都对本文件可见 —— 这与树解析器的星号导入语义一致。
 * - `#include <x>`（系统头）不记 import：它不是项目内模块，记了只会污染依赖图。
 */
import type { LanguagePlugin } from '../ide/backend/src/languages/plugin';
import type { LanguageSpec, ModuleCandidate, ModuleHint, WalkContext } from '../ide/backend/src/indexer/walker';
import type { LangId, SymbolKind } from '../ide/backend/src/types';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';

// ---------------------------------------------------------------- 路径工具（自备，不依赖阅读器）

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

function joinRel(...parts: string[]): string {
  const segs: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segs.length && segs[segs.length - 1] !== '..') segs.pop();
      else segs.push('..');
      continue;
    }
    segs.push(part);
  }
  return segs.join('/');
}

// ---------------------------------------------------------------- declarator 解析

/** 声明符里「名字」所在的节点（`*p` / `f()` / `Widget::id` / `a[3]` 都能挖到底）。 */
function declaratorName(node: any): any | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
    case 'operator_name':
    case 'destructor_name':
      return node;
    case 'qualified_identifier': {
      const name = node.childForFieldName('name');
      return declaratorName(name);
    }
    case 'function_declarator':
    case 'pointer_declarator':
    case 'reference_declarator':
    case 'array_declarator':
    case 'parenthesized_declarator':
    case 'init_declarator':
    case 'attributed_declarator':
      return declaratorName(node.childForFieldName('declarator'));
    default:
      return null;
  }
}

/** 声明符链上的函数声明符（判断「这是不是函数」）。 */
function functionDeclaratorOf(node: any): any | null {
  if (!node) return null;
  if (node.type === 'function_declarator') return node;
  if (
    node.type === 'pointer_declarator' ||
    node.type === 'reference_declarator' ||
    node.type === 'parenthesized_declarator' ||
    node.type === 'init_declarator' ||
    node.type === 'array_declarator' ||
    node.type === 'attributed_declarator'
  ) {
    return functionDeclaratorOf(node.childForFieldName('declarator'));
  }
  return null;
}

/** `Widget::id` / `demo::twice` → ['Widget','id']；普通 identifier → null。 */
function qualifiedParts(node: any): string[] | null {
  if (!node || node.type !== 'qualified_identifier') return null;
  const scope = node.childForFieldName('scope');
  const name = node.childForFieldName('name');
  if (!scope || !name) return null;
  const head = scope.type === 'qualified_identifier' ? qualifiedParts(scope) : [String(scope.text)];
  if (!head) return null;
  return [...head, String(name.text)];
}

/** 形参：`int a` / `T&& v` / `...` / `void`。 */
function defineParameters(list: any, ctx: WalkContext) {
  for (const p of (list?.namedChildren ?? []) as any[]) {
    if (p.type === 'parameter_declaration' || p.type === 'optional_parameter_declaration') {
      const decl = p.childForFieldName('declarator');
      const nameNode = declaratorName(decl);
      if (nameNode) ctx.define(p, { nameNode, kind: 'parameter' });
      const typeNode = p.childForFieldName('type');
      if (typeNode) ctx.walk(typeNode);
      // declarator 上只剩指针 / 数组包装，无新符号
      continue;
    }
    ctx.walk(p); // variadic_parameter / 默认值表达式 / 其它
  }
}

/** 变量声明符：`a` / `*p` / `arr[3]` / `v = expr`。 */
function defineVariable(decl: any, ctx: WalkContext, kind: SymbolKind) {
  if (!decl) return;
  if (decl.type === 'init_declarator') {
    const inner = decl.childForFieldName('declarator');
    const nameNode = declaratorName(inner);
    if (nameNode) ctx.define(inner ?? decl, { nameNode, kind });
    const value = decl.childForFieldName('value');
    if (value) ctx.walk(value);
    return;
  }
  const nameNode = declaratorName(decl);
  if (nameNode) ctx.define(decl, { nameNode, kind });
}

/** 函数定义 / 声明共用：登记名字、开作用域、登记形参、走返回类型与函数体。 */
function handleFunctionLike(
  node: any,
  ctx: WalkContext,
  opts: { kind: SymbolKind; bodyField?: string; declaratorIsField?: boolean },
) {
  const decl = node.childForFieldName('declarator');
  const fdecl = functionDeclaratorOf(decl);
  const inner = fdecl ? fdecl.childForFieldName('declarator') : decl;
  const nameNode = declaratorName(inner);
  if (nameNode) {
    const def = ctx.define(node, { nameNode, kind: opts.kind });
    const scope = ctx.enterScope(
      node,
      { kind: 'function', fixedName: String(nameNode.text) },
      String(nameNode.text),
    );
    if (def) def.bodyScopeId = scope.id;
    const typeNode = node.childForFieldName('type');
    if (typeNode) ctx.walk(typeNode);
    defineParameters(fdecl?.childForFieldName('parameters'), ctx);
    const bodyField = opts.bodyField ?? 'body';
    const body = node.childForFieldName(bodyField);
    if (body) ctx.walk(body);
    ctx.exitScope();
    return;
  }
  // 没有名字（如 `static { }` / 异常语法）：照常往里走，别丢内容
  for (const c of (node.namedChildren ?? []) as any[]) ctx.walk(c);
}

// ---------------------------------------------------------------- 内置符号（跳不动时归「外部依赖」）

const C_BUILTINS = new Set([
  'NULL', 'EOF', 'stdin', 'stdout', 'stderr', 'FILE', 'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'printf', 'fprintf', 'sprintf', 'snprintf', 'vprintf', 'puts', 'putchar', 'scanf', 'sscanf', 'fgets', 'fputs',
  'fopen', 'fclose', 'fread', 'fwrite', 'fflush', 'feof',
  'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memset', 'memmove', 'memcmp',
  'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strstr', 'strchr', 'strrchr', 'strtok',
  'atoi', 'atol', 'atof', 'strtol', 'strtod', 'abs', 'labs', 'qsort', 'bsearch',
  'exit', 'abort', 'atexit', 'getenv', 'system', 'assert',
]);

const CPP_BUILTINS = new Set([
  ...C_BUILTINS,
  'std', 'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'printf', 'size_t', 'nullptr_t',
  'vector', 'string', 'wstring', 'map', 'set', 'multimap', 'multiset', 'unordered_map', 'unordered_set',
  'pair', 'tuple', 'array', 'deque', 'list', 'queue', 'stack', 'priority_queue', 'optional', 'variant', 'any',
  'unique_ptr', 'shared_ptr', 'weak_ptr', 'make_unique', 'make_shared', 'move', 'forward', 'swap',
  'begin', 'end', 'size', 'sort', 'find', 'count', 'min', 'max', 'clamp', 'abs',
  'istream', 'ostream', 'iostream', 'ifstream', 'ofstream', 'stringstream',
  'exception', 'runtime_error', 'logic_error', 'out_of_range', 'invalid_argument',
  'override', 'final', 'nullptr', 'true', 'false',
]);

// ---------------------------------------------------------------- 语言定义

interface CLangOptions {
  id: LangId;
  label: string;
  extensions: string[];
  grammar: unknown;
  monaco: string;
  fence: string;
  color: string;
  builtins: Set<string>;
}

function makeLang(o: CLangOptions): LanguageSpec {
  const scopes: LanguageSpec['scopes'] = {
    compound_statement: { kind: 'block' },
    for_statement: { kind: 'block' },
    while_statement: { kind: 'block' },
    do_statement: { kind: 'block' },
    if_statement: { kind: 'block' },
    switch_statement: { kind: 'block' },
    else_clause: { kind: 'block' },
    case_statement: { kind: 'block' },
  };

  const handlers: LanguageSpec['handlers'] = {
    /** `#include "x.h"` → 星号导入（被包含文件的顶层符号对本文件可见）；系统头不记。 */
    preproc_include(node, ctx) {
      const path = node.childForFieldName('path');
      if (path?.type === 'string_literal') {
        const raw = String(path.text).replace(/^"|"$/g, '');
        const module = raw.startsWith('.') || raw.startsWith('/') ? raw : `./${raw}`;
        ctx.addImport({ localName: '*', module, kind: 'star', range: ctx.rangeOf(path) });
      }
      return true;
    },

    /** `#define MAX 100` → 常量。 */
    preproc_def(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'constant' });
      return true;
    },

    /** `#define SQR(x) ((x)*(x))` → 函数（宏体不参与解析，避免把参数名当引用）。 */
    preproc_function_def(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) ctx.define(node, { nameNode: name, kind: 'function' });
      return true;
    },

    /** 函数定义（含 C++ 的 `Widget::id` 与模板实例）。 */
    function_definition(node, ctx) {
      const decl = node.childForFieldName('declarator');
      const inner = functionDeclaratorOf(decl)?.childForFieldName('declarator');
      const kind: SymbolKind = inner?.type === 'qualified_identifier' ? 'method' : 'function';
      handleFunctionLike(node, ctx, { kind });
      return true;
    },

    /** 声明：函数声明或变量声明。 */
    declaration(node, ctx) {
      const decl = node.childForFieldName('declarator');
      if (functionDeclaratorOf(decl)) {
        handleFunctionLike(node, ctx, { kind: 'function' });
        return true;
      }
      const typeNode = node.childForFieldName('type');
      if (typeNode) ctx.walk(typeNode);
      for (const c of (node.namedChildren ?? []) as any[]) {
        if (c === decl || c === typeNode) continue;
        if (c.type === 'identifier' || c.type === 'init_declarator' || c.type.endsWith('_declarator')) {
          defineVariable(c, ctx, 'variable');
        }
      }
      if (decl) defineVariable(decl, ctx, 'variable');
      return true;
    },

    /** 类 / 结构体成员：函数 → method，其余 → field。 */
    field_declaration(node, ctx) {
      const decl = node.childForFieldName('declarator');
      const typeNode = node.childForFieldName('type');
      if (functionDeclaratorOf(decl)) {
        handleFunctionLike(node, ctx, { kind: 'method' });
        return true;
      }
      if (typeNode) ctx.walk(typeNode);
      for (const c of (node.namedChildren ?? []) as any[]) {
        if (c === typeNode) continue;
        if (c.type === 'field_identifier' || c.type === 'identifier' || c.type.endsWith('_declarator')) {
          defineVariable(c, ctx, 'field');
        }
      }
      return true;
    },

    struct_specifier: (node, ctx) => handleRecord('struct', node, ctx),
    class_specifier: (node, ctx) => handleRecord('class', node, ctx),
    union_specifier: (node, ctx) => handleRecord('struct', node, ctx),
    enum_specifier: (node, ctx) => handleRecord('enum', node, ctx),

    /** `typedef ... Point;`：登记类型名；被包裹的匿名结构体只登记成员。 */
    type_definition(node, ctx) {
      const decl = node.childForFieldName('declarator');
      const nameNode = declaratorName(decl);
      const typeNode = node.childForFieldName('type');
      const innerName =
        typeNode && ['struct_specifier', 'union_specifier', 'enum_specifier', 'class_specifier'].includes(typeNode.type)
          ? typeNode.childForFieldName('name')
          : null;
      if (nameNode && !(innerName && String(innerName.text) === String(nameNode.text))) {
        ctx.define(node, { nameNode, kind: 'type' });
      }
      if (typeNode) ctx.walk(typeNode);
      return true;
    },

    /** `namespace demo { ... }`。 */
    namespace_definition(node, ctx) {
      const name = node.childForFieldName('name');
      if (name) {
        const def = ctx.define(node, { nameNode: name, kind: 'namespace' });
        const scope = ctx.enterScope(
          node,
          // 命名空间相当于 C++ 的模块层：里面的顶层符号要能进工作区符号搜索
          { kind: 'namespace', fixedName: String(name.text), localDefs: false },
          String(name.text),
        );
        if (def) def.bodyScopeId = scope.id;
        const body = node.childForFieldName('body');
        if (body) ctx.walk(body);
        ctx.exitScope();
        return true;
      }
      // `namespace { ... }` 匿名
      const body = node.childForFieldName('body');
      ctx.enterScope(node, { kind: 'namespace', localDefs: false }, null);
      if (body) ctx.walk(body);
      ctx.exitScope();
      return true;
    },

    /** `template <typename T> ...`：类型参数登记为类型，其余照常。 */
    template_declaration(node, ctx) {
      const params = node.childForFieldName('parameters');
      if (params) {
        for (const p of (params.namedChildren ?? []) as any[]) {
          if (p.type === 'type_parameter_declaration' || p.type === 'template_template_parameter_declaration') {
            const nameNode = ((p.namedChildren ?? []) as any[]).find((c) => c.type === 'type_identifier');
            if (nameNode) ctx.define(p, { nameNode, kind: 'type' });
          } else {
            ctx.walk(p);
          }
        }
      }
      for (const c of (node.namedChildren ?? []) as any[]) {
        if (c !== params) ctx.walk(c);
      }
      return true;
    },

    /** `a.b` / `p->x`：对象按引用走，成员记成 member 引用（保留 `a.b` 链）。 */
    field_expression(node, ctx) {
      const arg = node.childForFieldName('argument');
      const field = node.childForFieldName('field');
      if (arg) ctx.walk(arg);
      if (field) {
        const parts = arg?.type === 'identifier' ? [String(arg.text), String(field.text)] : null;
        ctx.addRef(field, { kind: 'member', parts, text: String(node.text) });
      }
      return true;
    },

    /** `demo::twice`：限定名记成 member 引用。 */
    qualified_identifier(node, ctx) {
      const scope = node.childForFieldName('scope');
      const name = node.childForFieldName('name');
      if (scope) ctx.walk(scope);
      if (name) {
        ctx.addRef(name, { kind: 'member', parts: qualifiedParts(node), text: String(node.text) });
      }
      return true;
    },

    /** 字面量：登记字符串 / 数字（供 L6 值溯源与悬停）。 */
    string_literal(node, ctx) {
      ctx.walkChildren(node);
      return true;
    },
  };

  function handleRecord(kind: SymbolKind, node: any, ctx: WalkContext) {
    const name = node.childForFieldName('name');
    const def = name ? ctx.define(node, { nameNode: name, kind }) : null;
    const body = node.childForFieldName('body');
    if (body) {
      const scope = ctx.enterScope(node, { kind: 'class', fixedName: name?.text ?? undefined }, name?.text ?? null);
      if (def) def.bodyScopeId = scope.id;
      ctx.walk(body);
      ctx.exitScope();
    }
    return true;
  }

  return {
    id: o.id,
    label: o.label,
    extensions: o.extensions,
    monaco: o.monaco,
    fence: o.fence,
    color: o.color,
    refs: true,
    commentPrefixes: ['//', '/*', '*', '*/'],
    signatureStyle: 'java', // `int f(int a)`：返回类型在前、参数带类型 —— 与 Java 同形
    entryPatterns: [{ res: [/\b(?:int|void)\s+main\s*\(/], reason: 'C/C++ 的 main 函数' }],
    grammar: o.grammar,

    scopes,
    handlers,

    identifierTypes: ['identifier', 'type_identifier', 'namespace_identifier'],
    commentTypes: ['comment'],

    literalTypes: {
      number_literal: 'number',
      string_literal: 'string',
      char_literal: 'string',
      true: 'other',
      false: 'other',
      null: 'other',
      nullptr: 'other',
    },
    valueContainers: {
      init_declarator: ['value'],
      assignment_expression: ['right'],
      field_initializer: ['value'],
    },

    builtins: o.builtins,

    /**
     * `#include` 说明符 → 项目内文件。
     * 先按当前文件目录解析（C 的引号包含语义），再在项目里按后缀找回退
     * （对应编译器的 `-I` 搜索路径，这里不读构建系统，只取最浅的匹配）。
     */
    resolveModule(specifier: string, fromFile: string, hint: ModuleHint): ModuleCandidate[] | null {
      const spec = specifier.replace(/^\.\//, '');
      if (!spec) return null;
      const direct = joinRel(dirname(fromFile), spec);
      if (hint.exists(direct)) return [{ path: direct, kind: 'file' }];

      const matches: string[] = [];
      for (const f of hint.files()) {
        if (f === spec || f.endsWith(`/${spec}`)) matches.push(f);
      }
      if (!matches.length) return null;
      matches.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      return [{ path: matches[0], kind: 'file' }];
    },
  };
}

export const cLang = makeLang({
  id: 'c' as LangId,
  label: 'C',
  extensions: ['.c', '.h'],
  grammar: C,
  // Monaco 没有独立的 `c` 语法（只有 cpp / csharp）——借同一语法族的 cpp：
  // 它的关键字集包含 C，着色效果与 C 一致（标准 §一「范围 A」的合法做法）。
  monaco: 'cpp',
  fence: 'c',
  color: '#555555',
  builtins: C_BUILTINS,
});

export const cppLang = makeLang({
  id: 'cpp' as LangId,
  label: 'C++',
  extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.inl', '.ipp', '.tpp'],
  grammar: Cpp,
  monaco: 'cpp',
  fence: 'cpp',
  color: '#f34b7d',
  builtins: CPP_BUILTINS,
});

// ---------------------------------------------------------------- 插件导出

/**
 * 一个包出**两门语言**：C 与 C++（它们共用同一套声明符解析与包含语义）。
 * 加载器会把 `specs` 里的每个语言分别注册；同 id 冲突时先注册者胜。
 */
export const plugin: LanguagePlugin = {
  specs: [cLang, cppLang],
};
