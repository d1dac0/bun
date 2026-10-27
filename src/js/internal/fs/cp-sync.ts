// Taken and modified from node.js: https://github.com/nodejs/node/blob/main/lib/internal/fs/cp/cp-sync.js
// Also hosts the option validation and SystemError construction shared with
// internal/fs/cp (async) and the fs.cpSync/fs.cp/fs.promises.cp dispatchers,
// ported from node lib/internal/fs/utils.js and lib/internal/errors.js.
const { validateObject, validateBoolean, validateFunction, validateInteger } = require("internal/validators");
const {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} = require("node:fs");
const { dirname, isAbsolute, join, normalize, parse, resolve, sep } = require("node:path");

const { EEXIST, EISDIR, EINVAL, ENOTDIR } = $processBindingConstants.os.errno;

const ArrayPrototypeEvery = Array.prototype.every;
const ArrayPrototypeFilter = Array.prototype.filter;
const ArrayPrototypeJoin = Array.prototype.join;
const StringPrototypeIndexOf = String.prototype.indexOf;
const StringPrototypeSlice = String.prototype.slice;
const StringPrototypeSplit = String.prototype.split;

// COPYFILE_EXCL | COPYFILE_FICLONE | COPYFILE_FICLONE_FORCE
const kMaxCopyMode = 7;

const defaultCpOptions = {
  dereference: false,
  errorOnExist: false,
  filter: undefined,
  force: true,
  preserveTimestamps: false,
  recursive: false,
  verbatimSymlinks: false,
  mode: 0,
};

function decorateSystemError(err, prefix, context) {
  const { syscall, code, message: ctxMessage, path, dest, errno } = context;
  let message = `${prefix}: ${syscall} returned ${code} (${ctxMessage})`;
  if (path !== undefined) message += ` ${path}`;
  if (dest !== undefined) message += ` => ${dest}`;
  err.message = message;
  err.name = "SystemError";
  err.info = context;
  err.errno = errno;
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  if (dest !== undefined) err.dest = dest;
  return err;
}

function fsCpDirToNonDirError(context) {
  return decorateSystemError(
    $ERR_FS_CP_DIR_TO_NON_DIR(context.message),
    "Cannot overwrite non-directory with directory",
    context,
  );
}

function fsCpEExistError(context) {
  return decorateSystemError($ERR_FS_CP_EEXIST(context.message), "Target already exists", context);
}

function fsCpEinvalError(context) {
  return decorateSystemError($ERR_FS_CP_EINVAL(context.message), "Invalid src or dest", context);
}

function fsCpSubdirOfSelfError(src, dest) {
  return fsCpEinvalError({
    message: `cannot copy ${src} to a subdirectory of self ${dest}`,
    path: dest,
    syscall: "cp",
    errno: EINVAL,
    code: "EINVAL",
  });
}

function fsCpFifoPipeError(context) {
  return decorateSystemError($ERR_FS_CP_FIFO_PIPE(context.message), "Cannot copy a FIFO pipe", context);
}

function fsCpNonDirToDirError(context) {
  return decorateSystemError(
    $ERR_FS_CP_NON_DIR_TO_DIR(context.message),
    "Cannot overwrite directory with non-directory",
    context,
  );
}

function fsCpSocketError(context) {
  return decorateSystemError($ERR_FS_CP_SOCKET(context.message), "Cannot copy a socket file", context);
}

function fsCpSymlinkToSubdirectoryError(context) {
  return decorateSystemError(
    $ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY(context.message),
    "Cannot overwrite symlink in subdirectory of self",
    context,
  );
}

function fsCpUnknownError(context) {
  return decorateSystemError($ERR_FS_CP_UNKNOWN(context.message), "Cannot copy an unknown file type", context);
}

function fsEisdirError(context) {
  return decorateSystemError($ERR_FS_EISDIR(context.message), "Path is a directory", context);
}

function getValidMode(mode) {
  if (mode == null) {
    return 0;
  }
  validateInteger(mode, "mode", 0, kMaxCopyMode);
  return mode;
}

const kValidatedCpOptions = Symbol("kValidatedCpOptions");

function validateCpOptions(options) {
  // Callback fs.cp validates before delegating to fs.promises.cp; the brand
  // lets the second pass skip re-validating the same object.
  if (options?.[kValidatedCpOptions]) return options;
  if (options === undefined) {
    options = { ...defaultCpOptions };
    options[kValidatedCpOptions] = true;
    return options;
  }
  validateObject(options, "options");
  options = { ...defaultCpOptions, ...options };
  validateBoolean(options.dereference, "options.dereference");
  validateBoolean(options.errorOnExist, "options.errorOnExist");
  validateBoolean(options.force, "options.force");
  validateBoolean(options.preserveTimestamps, "options.preserveTimestamps");
  validateBoolean(options.recursive, "options.recursive");
  validateBoolean(options.verbatimSymlinks, "options.verbatimSymlinks");
  options.mode = getValidMode(options.mode);
  if (options.dereference === true && options.verbatimSymlinks === true) {
    throw $ERR_INCOMPATIBLE_OPTION_PAIR(
      'Option "dereference" cannot be used in combination with option "verbatimSymlinks"',
    );
  }
  const { filter } = options;
  if (filter !== undefined) {
    validateFunction(filter, "options.filter");
  }
  options[kValidatedCpOptions] = true;
  return options;
}

function areIdentical(srcStat, destStat) {
  return destStat.ino && destStat.dev && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
}

const normalizePathToArray = path =>
  ArrayPrototypeFilter.$call(StringPrototypeSplit.$call(resolve(path), sep), Boolean);

// Return true if dest is a subdir of src, otherwise false.
// It only checks the path strings.
function isSrcSubdir(src, dest) {
  const srcArr = normalizePathToArray(src);
  const destArr = normalizePathToArray(dest);
  return ArrayPrototypeEvery.$call(srcArr, (cur, i) => destArr[i] === cur);
}

// path.join("app/cur/..", "x") is "app/x". The system gives "releases/x" when app/cur links to releases/v2.
function hasNameBeforeDotDot(path) {
  if (process.platform === "win32" || typeof path !== "string") return false;
  if (StringPrototypeIndexOf.$call(path, "..") === -1) return false;
  const segments = StringPrototypeSplit.$call(path, "/");
  let sawName = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "..") {
      if (sawName) return true;
    } else if (segment !== "" && segment !== ".") {
      sawName = true;
    }
  }
  return false;
}

// Puts the segments of `path` on `stack`, the first one on top.
function pushSegments(stack: string[], path: string) {
  const segments = StringPrototypeSplit.$call(path, "/");
  for (let i = segments.length - 1; i >= 0; i--) stack.push(segments[i]);
}

// The real path of `path`, from lstat and readlink alone: fs.realpath needs /proc on Linux, read permission on macOS.
function realPathOfSync(path) {
  let real = isAbsolute(path) ? "/" : resolve(".");
  const missing: string[] = [];
  const rest: string[] = [];
  pushSegments(rest, path);
  let links = 0;
  while (rest.length) {
    const segment = rest.pop()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // A name that does not exist yet is a directory the copy makes, so `..` cancels it.
      if (missing.length) missing.pop();
      else real = dirname(real);
      continue;
    }
    if (missing.length) {
      missing.push(segment);
      continue;
    }
    const next = real === "/" ? "/" + segment : real + "/" + segment;
    let isLink;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      missing.push(segment);
      continue;
    }
    // More links than the system follows: stat() reports the loop (ELOOP).
    if (isLink && ++links > 40) statSync(path);
    if (!isLink || links > 40) {
      real = next;
      continue;
    }
    const target = readlinkSync(next);
    if (isAbsolute(target)) real = "/";
    pushSegments(rest, target);
  }
  return missing.length ? join(real, ArrayPrototypeJoin.$call(missing, "/")) : real;
}

// True when the system and path.resolve() give `path` different directories.
function textDiffersSync(path) {
  if (!hasNameBeforeDotDot(path)) return false;
  const real = realPathOfSync(path);
  try {
    return real !== realPathOfSync(normalize(path));
  } catch {
    // The caller did not give the text form. If it does not resolve (a file in the way), it is not this directory.
    return true;
  }
}

// `keep`: `dir` as given plus the name, as node's C++ CpSyncCopyDir (`src / name`). If not: what path.join() gives.
function childPathPrefix(dir, keep) {
  if (process.platform === "win32") return dir;
  if (keep) return dir[dir.length - 1] === "/" ? dir : dir + "/";
  return StringPrototypeSlice.$call(join(dir, "x"), 0, -1);
}

function childPath(prefix, name) {
  return process.platform === "win32" ? join(prefix, name) : prefix + name;
}

type BigIntStats = import("node:fs").BigIntStats;

// One per copy of a directory. A root keeps its path as given in child paths when textDiffersSync() is true for it.
interface CpWalk {
  keepSrc: boolean;
  keepDest: boolean;
  nested: boolean; // false until the root directory is listed
}

interface CpOptions {
  dereference: boolean;
  errorOnExist: boolean;
  filter: ((src: string, dest: string) => boolean | Promise<boolean>) | undefined;
  force: boolean;
  preserveTimestamps: boolean;
  recursive: boolean;
  verbatimSymlinks: boolean;
  mode: number;
}

interface CheckedPaths {
  __proto__: null;
  srcStat: BigIntStats;
  destStat: BigIntStats | null | undefined;
  skipped: false;
  walk?: CpWalk; // for the two roots, when src is a directory
}

interface SkippedPaths {
  __proto__: null;
  srcStat?: undefined;
  destStat?: undefined;
  skipped: true;
}

function checkPathsSync(src, dest, opts: CpOptions & { filter: undefined }): CheckedPaths;
function checkPathsSync(src, dest, opts: CpOptions, walk?: CpWalk): CheckedPaths | SkippedPaths;
function checkPathsSync(src, dest, opts: CpOptions, walk?: CpWalk): CheckedPaths | SkippedPaths {
  if (opts.filter) {
    const shouldCopy = opts.filter(src, dest);
    if ($isPromise(shouldCopy)) {
      throw $ERR_INVALID_RETURN_VALUE("boolean", "filter", shouldCopy);
    }
    if (!shouldCopy) return { __proto__: null, skipped: true };
  }
  const { srcStat, destStat } = getStatsSync(src, dest, opts);

  if (destStat) {
    if (areIdentical(srcStat, destStat)) {
      throw fsCpEinvalError({
        message: "src and dest cannot be the same",
        path: dest,
        syscall: "cp",
        errno: EINVAL,
        code: "EINVAL",
      });
    }
    if (srcStat.isDirectory() && !destStat.isDirectory()) {
      throw fsCpDirToNonDirError({
        message: `cannot overwrite non-directory ${dest} with directory ${src}`,
        path: dest,
        syscall: "cp",
        errno: EISDIR,
        code: "EISDIR",
      });
    }
    if (!srcStat.isDirectory() && destStat.isDirectory()) {
      throw fsCpNonDirToDirError({
        message: `cannot overwrite directory ${dest} with non-directory ${src}`,
        path: dest,
        syscall: "cp",
        errno: ENOTDIR,
        code: "ENOTDIR",
      });
    }
  }

  if (srcStat.isDirectory()) {
    if (walk !== undefined) {
      // A child path that keeps `name/..` is not text to compare. Its roots passed the check.
      if (!walk.keepSrc && !walk.keepDest && isSrcSubdir(src, dest)) throw fsCpSubdirOfSelfError(src, dest);
    } else {
      const keepSrc = textDiffersSync(src);
      const keepDest = textDiffersSync(dest);
      // node compares text (cp.js isSrcSubdir). That check stays where the text of src is right, and with `dereference`.
      const inside =
        keepSrc || keepDest
          ? isSrcSubdir(realPathOfSync(src), realPathOfSync(dest)) ||
            ((!keepSrc || opts.dereference) && isSrcSubdir(src, dest))
          : isSrcSubdir(src, dest);
      if (inside) throw fsCpSubdirOfSelfError(src, dest);
      return { __proto__: null, srcStat, destStat, skipped: false, walk: { keepSrc, keepDest, nested: false } };
    }
  }
  return { __proto__: null, srcStat, destStat, skipped: false };
}

function getStatsSync(src, dest, opts) {
  let destStat;
  const statFunc = opts.dereference
    ? file => statSync(file, { bigint: true })
    : file => lstatSync(file, { bigint: true });
  const srcStat = statFunc(src);
  try {
    destStat = statFunc(dest);
  } catch (err: any) {
    if (err.code === "ENOENT") return { srcStat, destStat: null };
    throw err;
  }
  return { srcStat, destStat };
}

function checkParentPathsSync(src, srcStat, dest, walk?: CpWalk) {
  const srcParent = resolve(dirname(src));
  const destParent = resolve(dirname(dest));
  if (destParent === srcParent || destParent === parse(destParent).root) return;
  let destStat;
  try {
    destStat = statSync(destParent, { bigint: true });
  } catch (err: any) {
    // Where a root keeps `name/..`, `destParent` is its text. One that does not resolve is not an ancestor.
    if (err.code === "ENOENT" || (walk !== undefined && (walk.keepSrc || walk.keepDest))) return;
    throw err;
  }
  if (areIdentical(srcStat, destStat)) {
    throw fsCpEinvalError({
      message: `cannot copy ${src} to a subdirectory of self ${dest}`,
      path: dest,
      syscall: "cp",
      errno: EINVAL,
      code: "EINVAL",
    });
  }
  return checkParentPathsSync(src, srcStat, destParent, walk);
}

// The native recursive copy (a single clonefile() on macOS) copies symlinks
// verbatim and clones special files, while node rewrites relative symlink
// targets against the source tree and raises ERR_FS_CP_SOCKET /
// ERR_FS_CP_FIFO_PIPE. It is therefore only node-equivalent for trees made of
// regular files and directories; anything else — including entries whose type
// the filesystem does not report — bails to the ported walker. Scan errors
// also bail so the walker surfaces them the way node would.
function treeContainsOnlyFilesAndDirsSync(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
      } else if (!entry.isFile()) {
        return false;
      }
    }
  }
  return true;
}

// node-correct validation before handing off to the native fast path
// (which performs the copy but does not implement node's cp error codes).
function tryNativeFastPathSync(src, dest, opts: CpOptions & { filter: undefined }) {
  const checked = checkPathsSync(src, dest, opts);
  const { srcStat, destStat } = checked;
  checkParentPathsSync(src, srcStat, dest, checked.walk);
  if (srcStat.isDirectory() && !opts.recursive) {
    throw fsEisdirError({
      message: `${src} is a directory (not copied)`,
      path: src,
      syscall: "cp",
      errno: EISDIR,
      code: "EISDIR",
    });
  }
  if (srcStat.isDirectory()) {
    // On macOS the native path clones the whole tree with a single
    // clonefile(). Only take it when the result is indistinguishable from
    // node's walker: dest must not exist (no merge semantics) and the tree
    // must contain only regular files and directories.
    return {
      // The scan below joins as text, so a src that is not its text takes the walker.
      ok: process.platform === "darwin" && !destStat && !checked.walk!.keepSrc && treeContainsOnlyFilesAndDirsSync(src),
      checked,
    };
  }
  // The single-file native copy is only node-equivalent for regular-file ->
  // regular-file (or missing dest). Symlinks (node resolves relative link
  // targets) and special files (node-specific error codes) must go through
  // the ported implementation.
  return { ok: srcStat.isFile() && (!destStat || destStat.isFile()), checked };
}

function cpSyncFn(src, dest, opts, checked?) {
  // `checked` carries the stats from a preceding tryNativeFastPathSync so the
  // fallback doesn't re-run the same checkPaths/checkParentPaths syscalls.
  const { srcStat, destStat, skipped, walk } = checked ?? checkPathsSync(src, dest, opts);
  if (skipped) return;
  if (checked === undefined) checkParentPathsSync(src, srcStat, dest, walk);
  return checkParentDir(destStat, src, dest, opts, walk);
}

function checkParentDir(destStat, src, dest, opts, walk: CpWalk | undefined) {
  const destParent = dirname(dest);
  if (!existsSync(destParent)) mkdirSync(destParent, { recursive: true });
  return getStats(destStat, src, dest, opts, walk);
}

function getStats(destStat, src, dest, opts, walk: CpWalk | undefined) {
  const statSyncFn = opts.dereference ? statSync : lstatSync;
  const srcStat = statSyncFn(src);

  if (srcStat.isDirectory() && opts.recursive) {
    return onDir(srcStat, destStat, src, dest, opts, walk ?? { keepSrc: false, keepDest: false, nested: false });
  } else if (srcStat.isDirectory()) {
    throw fsEisdirError({
      message: `${src} is a directory (not copied)`,
      path: src,
      syscall: "cp",
      errno: EISDIR,
      code: "EISDIR",
    });
  } else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) {
    return onFile(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isSymbolicLink()) {
    return onLink(destStat, src, dest, opts, walk);
  } else if (srcStat.isSocket()) {
    throw fsCpSocketError({
      message: `cannot copy a socket file: ${dest}`,
      path: dest,
      syscall: "cp",
      errno: EINVAL,
      code: "EINVAL",
    });
  } else if (srcStat.isFIFO()) {
    throw fsCpFifoPipeError({
      message: `cannot copy a FIFO pipe: ${dest}`,
      path: dest,
      syscall: "cp",
      errno: EINVAL,
      code: "EINVAL",
    });
  }
  throw fsCpUnknownError({
    message: `cannot copy an unknown file type: ${dest}`,
    path: dest,
    syscall: "cp",
    errno: EINVAL,
    code: "EINVAL",
  });
}

function onFile(srcStat, destStat, src, dest, opts) {
  if (!destStat) return copyFile(srcStat, src, dest, opts);
  return mayCopyFile(srcStat, src, dest, opts);
}

function mayCopyFile(srcStat, src, dest, opts) {
  if (opts.force) {
    unlinkSync(dest);
    return copyFile(srcStat, src, dest, opts);
  } else if (opts.errorOnExist) {
    throw fsCpEExistError({
      message: `${dest} already exists`,
      path: dest,
      syscall: "cp",
      errno: EEXIST,
      code: "EEXIST",
    });
  }
}

function copyFile(srcStat, src, dest, opts) {
  copyFileSync(src, dest, opts.mode);
  if (opts.preserveTimestamps) handleTimestamps(srcStat.mode, src, dest);
  return setDestMode(dest, srcStat.mode);
}

function handleTimestamps(srcMode, src, dest) {
  // Make sure the file is writable before setting the timestamp
  // otherwise open fails with EPERM when invoked with 'r+'
  // (through utimes call)
  if (fileIsNotWritable(srcMode)) makeFileWritable(dest, srcMode);
  return setDestTimestamps(src, dest);
}

function fileIsNotWritable(srcMode) {
  return (srcMode & 0o200) === 0;
}

function makeFileWritable(dest, srcMode) {
  return setDestMode(dest, srcMode | 0o200);
}

function setDestMode(dest, srcMode) {
  return chmodSync(dest, srcMode);
}

function setDestTimestamps(src, dest) {
  // The initial srcStat.atime cannot be trusted
  // because it is modified by the read(2) system call
  // (See https://nodejs.org/api/fs.html#fs_stat_time_values)
  const updatedSrcStat = statSync(src);
  return utimesSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
}

function onDir(srcStat, destStat, src, dest, opts, walk: CpWalk) {
  if (!destStat) return mkDirAndCopy(srcStat.mode, src, dest, opts, walk);
  if (opts.errorOnExist && !opts.force) {
    throw fsCpEExistError({
      message: `${dest} already exists`,
      path: dest,
      syscall: "cp",
      errno: EEXIST,
      code: "EEXIST",
    });
  }
  return copyDir(src, dest, opts, walk);
}

function mkDirAndCopy(srcMode, src, dest, opts, walk: CpWalk) {
  mkdirSync(dest);
  copyDir(src, dest, opts, walk);
  return setDestMode(dest, srcMode);
}

function copyDir(src, dest, opts, walk: CpWalk) {
  const dirents = readdirSync(src, { withFileTypes: true });
  if (dirents.length === 0) return;
  const srcPrefix = childPathPrefix(src, walk.nested || walk.keepSrc);
  const destPrefix = childPathPrefix(dest, walk.nested || walk.keepDest);
  walk.nested = true;
  for (const dirent of dirents) {
    const { name } = dirent;
    const srcItem = childPath(srcPrefix, name);
    const destItem = childPath(destPrefix, name);
    const { destStat, skipped } = checkPathsSync(srcItem, destItem, opts, walk);
    if (!skipped) getStats(destStat, srcItem, destItem, opts, walk);
  }
}

// The directory to resolve a relative link target against. `walk` is undefined when the link is a root.
function linkDirSync(link, walk: CpWalk | undefined) {
  const dir = dirname(link);
  if (walk !== undefined && !walk.keepSrc && !walk.keepDest) return dir;
  // Unlike node's JS walkers, which resolve against the text of `dir`: path.resolve() cancels its `name/..`.
  return hasNameBeforeDotDot(dir) ? realPathOfSync(dir) : dir;
}

function onLink(destStat, src, dest, opts, walk: CpWalk | undefined) {
  let resolvedSrc = readlinkSync(src);
  if (!opts.verbatimSymlinks && !isAbsolute(resolvedSrc)) {
    resolvedSrc = resolve(linkDirSync(src, walk), resolvedSrc);
  }
  if (!destStat) {
    return symlinkSync(resolvedSrc, dest);
  }
  let resolvedDest;
  try {
    resolvedDest = readlinkSync(dest);
  } catch (err: any) {
    // Dest exists and is a regular file or directory,
    // Windows may throw UNKNOWN error. If dest already exists,
    // fs throws error anyway, so no need to guard against it here.
    if (err.code === "EINVAL" || err.code === "UNKNOWN") {
      return symlinkSync(resolvedSrc, dest);
    }
    throw err;
  }
  if (!isAbsolute(resolvedDest)) {
    resolvedDest = resolve(linkDirSync(dest, walk), resolvedDest);
  }
  let srcIsDir = false;
  try {
    srcIsDir = statSync(src).isDirectory();
  } catch {}
  if (srcIsDir && isSrcSubdir(resolvedSrc, resolvedDest)) {
    throw fsCpEinvalError({
      message: `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`,
      path: dest,
      syscall: "cp",
      errno: EINVAL,
      code: "EINVAL",
    });
  }
  // Prevent copy if src is a subdir of dest since unlinking
  // dest in this case would result in removing src contents
  // and therefore a broken symlink would be created.
  if (statSync(dest).isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) {
    throw fsCpSymlinkToSubdirectoryError({
      message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
      path: dest,
      syscall: "cp",
      errno: EINVAL,
      code: "EINVAL",
    });
  }
  return copyLink(resolvedSrc, dest);
}

function copyLink(resolvedSrc, dest) {
  unlinkSync(dest);
  return symlinkSync(resolvedSrc, dest);
}

export default {
  cpSyncFn,
  validateCpOptions,
  tryNativeFastPathSync,
  errno: { EEXIST, EISDIR, EINVAL, ENOTDIR },
  fsCpDirToNonDirError,
  fsCpEExistError,
  fsCpEinvalError,
  fsCpFifoPipeError,
  fsCpNonDirToDirError,
  fsCpSocketError,
  fsCpSymlinkToSubdirectoryError,
  fsCpUnknownError,
  fsEisdirError,
  areIdentical,
  isSrcSubdir,
  fsCpSubdirOfSelfError,
  hasNameBeforeDotDot,
  pushSegments,
  childPathPrefix,
  childPath,
};
