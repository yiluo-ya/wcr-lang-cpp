# wcr-lang-cpp

C / C++ 语言插件（阅读器全功能参考实现）。标准见阅读器仓库的 `docs/08-language-plugin-spec.md`。

## 能力（C1–C10 全通）

| 能力 | 实现方式 |
|---|---|
| C1 高亮 | 借 Monaco 内置 `cpp`（Monaco 没有独立的 `c` 语法，两者同族） |
| C2 色点 | `color`：C `#555555` / C++ `#f34b7d` |
| C3 大纲 / C4 符号搜索 | tree-sitter AST → 函数 / 方法 / 类 / 结构体 / 枚举 / 命名空间 / 字段 / 常量 / 宏 |
| C5 跳转 / C6 引用 | 定义 + 引用提取；`#include "x.h"` 建模为星号导入 → 跨文件可跳 |
| C7 Hover | 定义 + 签名（`signatureStyle: 'java'`：`int f(int a)` 的返回类型在前） |
| C8 失败解释 | `printf` / `malloc` / `std::vector`… 收进 `builtins` → 归「外部依赖」 |
| C9 密度条 | `commentPrefixes: ['//', '/*', '*', '*/']` |
| C10 签名压平 | 多行声明压平为一行，参数不丢 |

已覆盖的语法：`#include` / `#define`（含函数宏）/ typedef / struct / union / enum / 函数与声明 / 类与访问修饰 /
namespace（含匿名）/ template / 限定名 `A::b` / 成员访问 `a.b`（`p->x`）/ 字面量。

## 已知边界（宁可不给，也不猜）

- 宏展开、模板实例化、`#ifdef` 条件编译不解析 —— 只读语法，不做预处理。
- `p->x` / `obj.field` 只在「对象是同文件的具名变量」时给成员链提示；对象类型跨文件时按
  「需要类型信息」处理（与阅读器其它语言同一口径）。
- 头文件搜索路径按「当前目录 → 项目内后缀匹配（取最浅）」近似，不读编译数据库 / CMake。

## 安装 / 开发

```bash
npm install

# 开发态（改代码后重启阅读器即生效）
wcr lang link .

# 或正式安装
wcr lang add .

# 阅读器里：wcr lang list 应看到「C（c）· C++（cpp）」
```

依赖装不上时看 `.npmrc`（`tree-sitter-c` / `tree-sitter-cpp` 的 peer 声明是过期的）。
tree-sitter 走 prebuild，**不需要本地编译**。

## 类型来源（单独 clone 后请注意）

`index.ts` 只**按类型**引用阅读器的定义（`import type`）：

```ts
import type { LanguagePlugin } from '../ide/backend/src/languages/plugin';
```

这类导入在运行时会被完全擦除，所以**不影响使用** —— `wcr lang link .` 直接可用；
但单独 clone 到别处时，编辑器与 `tsc --noEmit` 会报「找不到模块」。两种应对：

1. 只要能用：忽略即可（运行时无关）。
2. 想要类型提示：把阅读器仓库与本仓库**并排放**，且阅读器目录名为 `ide`：

   ```
   parent/
   ├── ide/            ← 阅读器仓库
   └── wcr-lang-cpp/   ← 本仓库
   ```

以后会提供 `@wcr/lang-sdk`（插件只需依赖它，不再相对引用阅读器源码）。

## 验证

```bash
# 阅读器仓库里
node tmp/cppverify.mjs <port>   # C1–C10 的 API 层验收
node tmp/cppui.mjs <port>       # C1 的前端验收（真实页面里的着色）
```

## 许可

MIT，见 [LICENSE](LICENSE)。
