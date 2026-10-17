import {
  manifest,
  compareManifests,
  maintenance,
  consistentBackup,
} from "../lib/operations.ts";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "manifest" && args.length === 1)
    console.log(JSON.stringify(manifest(args[0]), null, 2));
  else if (command === "compare" && args.length === 2) {
    const a = manifest(args[0]),
      b = manifest(args[1]);
    if (!compareManifests(a, b))
      throw Error("数据库业务数据或 generation 不一致");
    console.log(
      "schema 3 全部业务表与 generation 一致（忽略运行租约和维护开关）",
    );
  } else if (
    command === "maintenance" &&
    args.length === 2 &&
    ["on", "off"].includes(args[1])
  ) {
    maintenance(args[0], args[1] === "on");
    console.log(`维护只读 ${args[1]}`);
  } else if (command === "backup" && args.length === 2)
    console.log(await consistentBackup(args[0], args[1]));
  else
    throw Error(
      "用法：ops manifest <db> | compare <db1> <db2> | maintenance <db> on|off | backup <db> <目录>",
    );
} catch {
  console.error(
    "运维操作失败：检查命令、schema 3、文件权限、完整性、磁盘及是否存在写事务；未公布半成品备份。",
  );
  process.exitCode = 1;
}
