import { describe, expect, jest, test } from "bun:test";
import fs from "fs";
import { bunEnv, bunExe, type DirectoryTree, isLinux, isPosix, isWindows, tempDir } from "harness";
import { mkfifo } from "mkfifo";
import { isAbsolute, join } from "path";

const impls = [
  ["cpSync", fs.cpSync],
  ["cp", fs.promises.cp],
] as const;

for (const [name, copy] of impls) {
  async function copyShouldThrow(...args: Parameters<typeof copy>) {
    try {
      await (copy as any)(...args);
    } catch (e: any) {
      if (e?.code?.toUpperCase() === "TODO") {
        throw new Error("Expected " + name + "() to throw non TODO error");
      }
      return e;
    }
    throw new Error("Expected " + name + "() to throw");
  }

  function assertContent(path: string, content: string) {
    expect(fs.readFileSync(path, "utf8")).toBe(content);
  }

  describe("fs." + name, () => {
    test("single file", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
      });

      await copy(basename + "/from/a.txt", basename + "/to.txt");

      expect(fs.readFileSync(basename + "/to.txt", "utf8")).toBe("a");
    });

    test("refuse to copy directory with 'recursive: false'", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
      });

      const e = await copyShouldThrow(basename + "/from", basename + "/result");
      expect(e.code).toBe("ERR_FS_EISDIR");
      // The path field echoes the caller's string verbatim (node does not
      // resolve or normalize it), so expect the same concatenation we passed.
      expect(e.path).toBe(basename + "/from");
    });

    test("recursive directory structure - no destination", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b/e.txt": "e",
        "from/c.txt": "c",
        "from/w/y/x/z.txt": "z",
      });

      await copy(basename + "/from", basename + "/result", { recursive: true });

      assertContent(basename + "/result/a.txt", "a");
      assertContent(basename + "/result/b/e.txt", "e");
      assertContent(basename + "/result/c.txt", "c");
      assertContent(basename + "/result/w/y/x/z.txt", "z");
    });

    test("recursive directory structure - overwrite existing files by default", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b/e.txt": "e",
        "from/c.txt": "c",
        "from/w/y/x/z.txt": "z",

        "result/a.txt": "fail",
        "result/w/y/x/z.txt": "lose",
        "result/w/y/v.txt": "keep this",
      });

      await copy(basename + "/from", basename + "/result", { recursive: true });

      assertContent(basename + "/result/a.txt", "a");
      assertContent(basename + "/result/b/e.txt", "e");
      assertContent(basename + "/result/c.txt", "c");
      assertContent(basename + "/result/w/y/x/z.txt", "z");
      assertContent(basename + "/result/w/y/v.txt", "keep this");
    });

    test("recursive directory structure - 'force: false' does not overwrite existing files", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "lose",
        "from/b/e.txt": "e",
        "from/c.txt": "c",
        "from/w/y/x/z.txt": "lose",

        "result/a.txt": "win",
        "result/w/y/x/z.txt": "win",
        "result/w/y/v.txt": "keep this",
      });

      await copy(basename + "/from", basename + "/result", { recursive: true, force: false });

      assertContent(basename + "/result/a.txt", "win");
      assertContent(basename + "/result/b/e.txt", "e");
      assertContent(basename + "/result/c.txt", "c");
      assertContent(basename + "/result/w/y/x/z.txt", "win");
      assertContent(basename + "/result/w/y/v.txt", "keep this");
    });

    test("'force: false' on a single file doesn't override", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "lose",
        "result/a.txt": "win",
      });

      await copy(basename + "/from/a.txt", basename + "/result/a.txt", { force: false });

      assertContent(basename + "/result/a.txt", "win");
    });

    test("'force: true' on a single file does override", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "win",
        "result/a.txt": "lose",
      });

      await copy(basename + "/from/a.txt", basename + "/result/a.txt", { force: true });

      assertContent(basename + "/result/a.txt", "win");
    });

    test("'force: false' + 'errorOnExist: true' can throw", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "lose",
        "result/a.txt": "win",
      });

      const e = await copyShouldThrow(basename + "/from/a.txt", basename + "/result/a.txt", {
        force: false,
        errorOnExist: true,
      });
      expect(e.code).toBe("ERR_FS_CP_EEXIST");
      // As above, the path field carries the caller's string verbatim.
      expect(e.path).toBe(basename + "/result/a.txt");

      assertContent(basename + "/result/a.txt", "win");
    });

    test("symlinks - single file", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
      });

      fs.symlinkSync(basename + "/from/a.txt", basename + "/from/a_symlink.txt");

      await copy(basename + "/from/a_symlink.txt", basename + "/result.txt");
      await copy(basename + "/from/a_symlink.txt", basename + "/result2.txt", { recursive: false });

      const stats = fs.lstatSync(basename + "/result.txt");
      expect(stats.isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(basename + "/result.txt", "utf8")).toBe("a");

      const stats2 = fs.lstatSync(basename + "/result2.txt");
      expect(stats2.isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(basename + "/result2.txt", "utf8")).toBe("a");
    });

    test("symlinks - single file recursive", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
      });

      fs.symlinkSync(basename + "/from/a.txt", basename + "/from/a_symlink.txt");

      await copy(basename + "/from/a_symlink.txt", basename + "/result.txt", { recursive: true });

      const stats = fs.lstatSync(basename + "/result.txt");
      expect(stats.isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(basename + "/result.txt", "utf8")).toBe("a");
    });

    test("symlinks - directory recursive", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
        "from/dir/c.txt": "c",
      });

      fs.symlinkSync(basename + "/from/a.txt", basename + "/from/a_symlink.txt");
      fs.symlinkSync(basename + "/from/dir", basename + "/from/dir_symlink");

      await copy(basename + "/from", basename + "/result", { recursive: true });

      const statsFile = fs.lstatSync(basename + "/result/a_symlink.txt");
      expect(statsFile.isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(basename + "/result/a_symlink.txt", "utf8")).toBe("a");

      const statsDir = fs.lstatSync(basename + "/result/dir_symlink");
      expect(statsDir.isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(basename + "/result/dir_symlink")).toEqual(["c.txt"]);
    });

    test("symlinks - directory recursive 2", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
        "from/dir/c.txt": "c",
      });

      fs.symlinkSync(basename + "/from/a.txt", basename + "/from/a_symlink.txt");
      fs.symlinkSync(basename + "/from/dir", basename + "/from/dir_symlink");
      fs.mkdirSync(basename + "/result");

      await copy(basename + "/from", basename + "/result", { recursive: true });

      const statsFile = fs.lstatSync(basename + "/result/a_symlink.txt");
      expect(statsFile.isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(basename + "/result/a_symlink.txt", "utf8")).toBe("a");

      const statsDir = fs.lstatSync(basename + "/result/dir_symlink");
      expect(statsDir.isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(basename + "/result/dir_symlink")).toEqual(["c.txt"]);
    });

    test("symlinks - copied link target is the original target, not the source link path", async () => {
      // Previously the ELOOP fallback on Linux/FreeBSD called symlink(src, dest),
      // so the copied link's target string was the path of the *source* symlink
      // and every copied link pointed back into the source tree.
      await using basename = tempDir("cp", {
        "target.txt": "hello",
        "from/keep": "",
      });

      const origTarget = join(basename, "target.txt");

      // Absolute target — exercises the isAbsolute fast path.
      const srcAbs = join(basename, "from", "abs_link");
      fs.symlinkSync(origTarget, srcAbs);

      // Relative target — exercises the dirname(src) resolve path.
      const srcRel = join(basename, "from", "rel_link");
      fs.symlinkSync(join("..", "target.txt"), srcRel);

      await copy(basename + "/from", basename + "/to", { recursive: true });

      for (const [which, srcLink] of [
        ["abs_link", srcAbs],
        ["rel_link", srcRel],
      ] as const) {
        const copiedLink = join(basename, "to", which);
        expect(fs.lstatSync(copiedLink).isSymbolicLink()).toBe(true);

        // The copied link's target string must not be the path of the source
        // symlink. With the bug, readlink(copiedLink) returned srcLink.
        expect(fs.readlinkSync(copiedLink)).not.toBe(srcLink);
        expect(fs.realpathSync(copiedLink)).toBe(fs.realpathSync(origTarget));
      }

      // Deleting the source tree must not break the absolute link, since its
      // target lives outside the source tree. With the bug, the copied link
      // pointed at from/abs_link and would dangle once from/ was removed.
      fs.rmSync(join(basename, "from"), { recursive: true, force: true });
      expect(fs.readFileSync(join(basename, "to", "abs_link"), "utf8")).toBe("hello");
    });

    test("symlinks - relative target inside the tree is resolved against the source tree", async () => {
      // node resolves a relative link target against the directory of the
      // source link and writes the absolute result into the copy. A verbatim
      // copy of the link (e.g. a whole-tree clonefile) would keep "../a.txt".
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/sub/keep.txt": "keep",
      });
      fs.symlinkSync(join("..", "a.txt"), join(basename, "from", "sub", "link"));

      await copy(join(basename, "from"), join(basename, "result"), { recursive: true });

      const copiedLink = join(basename, "result", "sub", "link");
      expect(fs.lstatSync(copiedLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(copiedLink)).toBe(join(basename, "from", "a.txt"));
      expect(fs.readFileSync(copiedLink, "utf8")).toBe("a");
    });

    test.skipIf(isWindows)("recursive - file and directory modes are preserved into a fresh destination", async () => {
      await using basename = tempDir("cp", {
        "from/d/f.txt": "x",
      });
      fs.chmodSync(join(basename, "from", "d", "f.txt"), 0o600);
      fs.chmodSync(join(basename, "from", "d"), 0o700);

      await copy(join(basename, "from"), join(basename, "result"), { recursive: true });

      expect({
        dirMode: fs.statSync(join(basename, "result", "d")).mode & 0o777,
        fileMode: fs.statSync(join(basename, "result", "d", "f.txt")).mode & 0o777,
        content: fs.readFileSync(join(basename, "result", "d", "f.txt"), "utf8"),
      }).toEqual({
        dirMode: 0o700,
        fileMode: 0o600,
        content: "x",
      });
    });

    test.skipIf(isWindows)("recursive - FIFO inside the tree is rejected with ERR_FS_CP_FIFO_PIPE", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
      });
      mkfifo(join(basename, "from", "pipe"), 0o666);
      expect(fs.lstatSync(join(basename, "from", "pipe")).isFIFO()).toBe(true);

      const e = await copyShouldThrow(join(basename, "from"), join(basename, "result"), { recursive: true });
      expect(e.code).toBe("ERR_FS_CP_FIFO_PIPE");
    });

    test("filter - works", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
      });

      await copy(basename + "/from", basename + "/result", {
        filter: (src: string) => {
          // cp joins child paths with the platform separator, so on Windows
          // the filter sees backslash-separated paths; normalize for the
          // assertion.
          src = src.replaceAll("\\", "/");
          return src.endsWith("/from") || src.includes("a.txt");
        },
        recursive: true,
      });

      expect(fs.existsSync(basename + "/result/a.txt")).toBe(true);
      expect(fs.existsSync(basename + "/result/b.txt")).toBe(false);
    });

    test("filter - paths given are correct and relative", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
      });

      const filter = jest.fn<(src: string, dest: string) => boolean>((src: string) => true);

      let prev = process.cwd();
      process.chdir(String(basename));

      await copy(join(basename, "from"), join(basename, "result"), {
        filter,
        recursive: true,
      });

      process.chdir(prev);

      expect(filter.mock.calls.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
        [join(basename, "from"), join(basename, "result")],
        [join(basename, "from", "a.txt"), join(basename, "result", "a.txt")],
        [join(basename, "from", "b.txt"), join(basename, "result", "b.txt")],
      ]);
    });

    test("trailing slash", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
      });

      await copy(basename + "/from/", basename + "/result/", { recursive: true });

      assertContent(basename + "/result/a.txt", "a");
      assertContent(basename + "/result/b.txt", "b");
    });

    test("copy directory will ensure directory exists", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
      });

      fs.mkdirSync(basename + "/result/");

      await copy(basename + "/from/", basename + "/hello/world/", { recursive: true });

      assertContent(basename + "/hello/world/a.txt", "a");
      assertContent(basename + "/hello/world/b.txt", "b");
    });

    test("relative paths for directories", async () => {
      await using basename = tempDir("cp", {
        "from/a.txt": "a",
        "from/b.txt": "b",
        "from/a.dir": { "c.txt": "c" },
      });

      const filter = jest.fn((src: string) => true);

      let prev = process.cwd();
      process.chdir(String(basename));

      await copy("from", "result", {
        recursive: true,
      });

      process.chdir(prev);

      assertContent(basename + "/result/a.dir/c.txt", "c");
    });

    test.if(process.platform === "win32")("should not throw EBUSY when copying the same file on windows", async () => {
      await using basename = tempDir("cp", {
        "hey": "hi",
      });

      // node rejects copying a file onto itself with ERR_FS_CP_EINVAL;
      // the regression this guards against is throwing EBUSY instead.
      let err: any;
      try {
        await copy(basename + "/hey", basename + "/hey");
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("ERR_FS_CP_EINVAL");
    });
  });
}

// `app/cur` is a symlink to `releases/v2`. For the system `app/cur/..` is
// `releases`. As text (path.join, path.resolve) it is `app`. On Windows the
// system cancels `cur/..` as text too, so the two never differ there.
describe.skipIf(isWindows)("a root that holds <symlink>/..", () => {
  const impls = [
    [
      "cpSync",
      async (src: fs.PathLike, dest: string, opts?: fs.CopySyncOptions) => fs.cpSync(src as string, dest, opts),
    ],
    [
      "promises.cp",
      (src: fs.PathLike, dest: string, opts?: fs.CopyOptions) => fs.promises.cp(src as string, dest, opts),
    ],
    [
      "cp",
      (src: fs.PathLike, dest: string, opts: fs.CopyOptions = {}) =>
        new Promise<void>((resolve, reject) =>
          fs.cp(src as string, dest, opts, err => (err ? reject(err) : resolve())),
        ),
    ],
  ] as const;

  function fixture() {
    const dir = tempDir("cp-dotdot", {
      "app/config.json": "text twin",
      "releases/config.json": "live",
      "releases/v2/inner.txt": "inner",
      "from/a.txt": "a",
      "from/sub/b.txt": "b",
    });
    fs.symlinkSync("../releases/v2", join(dir, "app", "cur"));
    return dir;
  }

  // Every entry below `root`: the content of a file, the target of a link, or "dir".
  function tree(root: string, prefix = "", out: Record<string, string> = {}) {
    for (const entry of fs.readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        out[path] = "dir";
        tree(root, path + "/", out);
      } else {
        out[path] = entry.isSymbolicLink()
          ? "-> " + fs.readlinkSync(join(root, path))
          : fs.readFileSync(join(root, path), "utf8");
      }
    }
    return out;
  }

  const releases = { "config.json": "live", "v2": "dir", "v2/inner.txt": "inner" };
  const from = { "a.txt": "a", "sub": "dir", "sub/b.txt": "b" };

  describe.concurrent.each(impls)("fs.%s", (_, copy) => {
    test.each([
      ["app/cur/..", releases],
      ["app/cur/../", releases],
      ["app/cur/../v2", { "inner.txt": "inner" }],
    ])("copies the entries of the source that the system resolves: %s", async (src, expected) => {
      using dir = fixture();
      await copy(`${dir}/${src}`, `${dir}/out`, { recursive: true });
      expect(tree(`${dir}/out`)).toEqual(expected);
    });

    // Unlike node: its JS walker (every `filter`) gives the filter `app/config.json` and then throws ENOENT.
    test("gives the filter paths that name the entries", async () => {
      using dir = fixture();
      const src = `${dir}/app/cur/..`;
      const dest = `${dir}/out`;
      const seen: string[][] = [];
      await copy(src, dest, {
        recursive: true,
        filter: (from, to) => {
          seen.push([from, to, fs.statSync(from).isDirectory() ? "dir" : fs.readFileSync(from, "utf8")]);
          return true;
        },
      });
      // The filter gets the root first. The order below it is the order of readdir.
      expect(seen.shift()).toEqual([src, dest, "dir"]);
      expect(seen.sort()).toEqual([
        [`${src}/config.json`, `${dest}/config.json`, "live"],
        [`${src}/v2`, `${dest}/v2`, "dir"],
        [`${src}/v2/inner.txt`, `${dest}/v2/inner.txt`, "inner"],
      ]);
      expect(tree(dest)).toEqual(releases);
    });

    test.each([
      ["copy", "releases/copy", {}, true],
      ["copy", "releases/copy", {}, false],
      ["n1/n2/copy", "releases/n1/n2/copy", {}, false],
      ["copy", "releases/copy", { preserveTimestamps: true }, true],
      ["copy", "releases/copy", { dereference: true }, true],
    ])(
      "writes into the destination that the system resolves: app/cur/../%s -> %s %j",
      async (dest, real, opts, twin) => {
        using dir = fixture();
        // The text twin of the destination. Nothing may land in it.
        if (twin) fs.mkdirSync(`${dir}/app/copy`);
        await copy(`${dir}/from`, `${dir}/app/cur/../${dest}`, { recursive: true, ...opts });
        expect(tree(`${dir}/${real}`)).toEqual(from);
        if (twin) expect(tree(`${dir}/app/copy`)).toEqual({});
      },
    );

    test("merges into a destination that exists", async () => {
      using dir = fixture();
      fs.writeFileSync(`${dir}/releases/a.txt`, "old");
      await copy(`${dir}/from`, `${dir}/app/cur/..`, { recursive: true });
      expect(tree(`${dir}/releases`)).toEqual({ ...releases, ...from });
      expect(tree(`${dir}/app`)).toEqual({ "config.json": "text twin", "cur": "-> ../releases/v2" });
    });

    test("keeps the strings of path.join when the text is the same directory", async () => {
      using dir = fixture();
      // `cur` is a directory, then a link to a directory beside it. Only a link out of `app` changes the strings.
      const seen: string[][] = [];
      const filter = (from: string) => (seen.push([from]), true);
      const src = `${dir}/app/cur/..`;

      fs.unlinkSync(`${dir}/app/cur`);
      fs.mkdirSync(`${dir}/app/cur`);
      await copy(src, `${dir}/out1`, { recursive: true, filter });
      fs.rmdirSync(`${dir}/app/cur`);
      fs.mkdirSync(`${dir}/app/real`);
      fs.symlinkSync("real", `${dir}/app/cur`);
      await copy(src, `${dir}/out2`, { recursive: true, filter });
      fs.unlinkSync(`${dir}/app/cur`);
      fs.symlinkSync("../releases/v2", `${dir}/app/cur`);
      await copy(src, `${dir}/out3`, { recursive: true, filter });

      expect(seen.flat().sort()).toEqual(
        [
          src,
          `${dir}/app/config.json`,
          `${dir}/app/cur`,
          src,
          `${dir}/app/config.json`,
          `${dir}/app/cur`,
          `${dir}/app/real`,
          src,
          `${src}/config.json`,
          `${src}/v2`,
          `${src}/v2/inner.txt`,
        ].sort(),
      );
    });

    test.each([
      // main gives ENOENT for the first three, and leaves directories in the source.
      ["the destination is inside the source", "releases", "app/cur/../copy"],
      ["the parent of the destination does not exist", "releases", "app/cur/../new/copy"],
      ["a name that does not exist before the link", "releases", "new/../app/cur/../copy"],
      ["the source holds the link", "app/cur/..", "releases/v2/copy"],
      // The same as main and node: no name is a link, or the text check of node says the same.
      ["no name is a link", "releases/v2/..", "releases/v2/../new/copy"],
      ["a name that does not exist, no link", "from", "new/../from/x"],
      ["the destination is the parent of the source", "releases/v2", "releases/v2/.."],
      ["the destination is the parent of the source, through the link", "releases/v2", "app/cur/.."],
      ["the text of the destination is inside the source", "app", "app/cur/../copy"],
    ])("refuses to copy a directory into itself: %s", async (_, src, dest) => {
      using dir = fixture();
      const before = tree(`${dir}`);
      let err: any;
      try {
        await copy(`${dir}/${src}`, `${dir}/${dest}`, { recursive: true });
      } catch (e) {
        err = e;
      }
      expect({ code: err?.code, path: err?.path, message: err?.message }).toEqual({
        code: "ERR_FS_CP_EINVAL",
        path: `${dir}/${dest}`,
        message: `Invalid src or dest: cp returned EINVAL (cannot copy ${dir}/${src} to a subdirectory of self ${dir}/${dest}) ${dir}/${dest}`,
      });
      expect(tree(`${dir}`)).toEqual(before);
    });

    test("with dereference, keeps the text check of node", async () => {
      using dir = fixture();
      const before = tree(`${dir}`);
      let err: any;
      try {
        await copy(`${dir}/app`, `${dir}/app/cur/../v2/copy`, { recursive: true, dereference: true });
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("ERR_FS_CP_EINVAL");
      expect(tree(`${dir}`)).toEqual(before);
    });

    // Unlike node's fs.cp and fs.promises.cp, which compare the text and throw ERR_FS_CP_EINVAL. Node's cpSync copies.
    test("copies when only the text form of the source holds the destination", async () => {
      using dir = fixture();
      await copy(`${dir}/app/cur/..`, `${dir}/app/out`, { recursive: true });
      expect(tree(`${dir}/app/out`)).toEqual(releases);
    });

    // Unlike node's JS walkers, which resolve the target against the text directory. Node's cpSync gives these targets.
    test("resolves a relative link target against the directory that holds the link", async () => {
      using dir = fixture();
      fs.symlinkSync("config.json", `${dir}/releases/link`);
      fs.symlinkSync("../config.json", `${dir}/releases/v2/up`);

      await copy(`${dir}/app/cur/..`, `${dir}/out`, { recursive: true });
      expect(tree(`${dir}/out`)).toEqual({
        ...releases,
        "link": `-> ${dir}/releases/config.json`,
        "v2/up": `-> ${dir}/releases/config.json`,
      });

      await copy(`${dir}/app/cur/../link`, `${dir}/out-link`);
      expect(fs.readlinkSync(`${dir}/out-link`)).toBe(`${dir}/releases/config.json`);
    });

    test("a file in the way of the text form does not stop the copy", async () => {
      using dir = fixture();
      // `app/v2` is the text form of `app/cur/../v2`. Here it is a file.
      fs.writeFileSync(`${dir}/app/v2`, "in the way");
      fs.symlinkSync("../config.json", `${dir}/releases/v2/up`);

      await copy(`${dir}/app/cur/..`, `${dir}/out`, { recursive: true });
      expect(tree(`${dir}/out`)).toEqual({ ...releases, "v2/up": `-> ${dir}/releases/config.json` });

      await copy(`${dir}/from`, `${dir}/app/cur/../v2/copy`, { recursive: true });
      expect(tree(`${dir}/releases/v2/copy`)).toEqual(from);

      await copy(`${dir}/from`, `${dir}/app/cur/../v2/two/levels`, { recursive: true });
      expect(tree(`${dir}/releases/v2/two/levels`)).toEqual(from);
    });

    test("does not need read permission on a directory above the destination", async () => {
      using dir = fixture();
      // The path goes through `app`, which the copy can search but not list.
      fs.chmodSync(`${dir}/app`, 0o311);
      try {
        await copy(`${dir}/from`, `${dir}/app/cur/../copy`, { recursive: true });
      } finally {
        fs.chmodSync(`${dir}/app`, 0o755);
      }
      expect(tree(`${dir}/releases/copy`)).toEqual(from);
    });

    // The same as main and node: the text check of node stays where the text of the source is right.
    test.each([false, true])(
      "refuses when the text of the destination is inside the source, with its text twin: %p",
      async twin => {
        using dir = fixture();
        fs.mkdirSync(`${dir}/releases/sub`);
        if (twin) fs.mkdirSync(`${dir}/app/sub`);
        const before = tree(`${dir}`);
        let err: any;
        try {
          await copy(`${dir}/app`, `${dir}/app/cur/../sub/copy`, { recursive: true });
        } catch (e) {
          err = e;
        }
        expect(err?.code).toBe("ERR_FS_CP_EINVAL");
        expect(tree(`${dir}`)).toEqual(before);
      },
    );

    test("resolves a link target below a link that has the name of its target directory", async () => {
      using dir = fixture();
      // `app/same/../same` and its text form `app/same` are one directory. Its parent is `releases`, not `app`.
      fs.mkdirSync(`${dir}/releases/same`);
      fs.symlinkSync("../releases/same", `${dir}/app/same`);
      fs.symlinkSync("../config.json", `${dir}/releases/same/up`);

      await copy(`${dir}/app/same/..`, `${dir}/out`, { recursive: true });
      expect(fs.readlinkSync(`${dir}/out/same/up`)).toBe(`${dir}/releases/config.json`);
    });

    test("a Buffer root with <symlink>/.. throws as a Buffer root without it does", async () => {
      using dir = fixture();
      const code = async (src: string) => {
        try {
          await copy(Buffer.from(src), `${dir}/out`, { recursive: true });
        } catch (e: any) {
          return e.code;
        }
        return "copied";
      };
      expect([await code(`${dir}/app/cur/..`), await code(`${dir}/releases`)]).toEqual([
        "ERR_INVALID_ARG_TYPE",
        "ERR_INVALID_ARG_TYPE",
      ]);
    });
  });
});

test("cp with missing callback throws", () => {
  expect(() => {
    // @ts-expect-error
    fs.cp("a", "b" as any);
  }).toThrow(/"cb"/);
});

// On Windows, _copySingleFileSync's reparse-point branch opens a handle to the
// source symlink to resolve its target via GetFinalPathNameByHandleW. Previously
// that handle was never closed, leaking one OS handle per symlink copied. Over a
// large tree (e.g. node_modules with junctions) this eventually exhausts the
// process handle table.
test.skipIf(!isWindows)("cpSync over symlinks does not leak Windows handles", () => {
  const { dlopen } = require("bun:ffi");
  const k32 = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: "ptr" },
    GetProcessHandleCount: { args: ["ptr", "ptr"], returns: "i32" },
  });
  const out = new Uint32Array(1);
  const handleCount = () => {
    if (k32.symbols.GetProcessHandleCount(k32.symbols.GetCurrentProcess(), out) === 0) {
      throw new Error("GetProcessHandleCount failed");
    }
    return out[0];
  };

  const N = 64;
  using basename = tempDir("cp-symlink-leak", {
    "from/target.txt": "hello",
  });
  for (let i = 0; i < N; i++) {
    fs.symlinkSync(join(basename, "from", "target.txt"), join(basename, "from", `link${i}.txt`));
  }

  // Warm up once so any lazy init (thread pool, path buffers, etc.) doesn't
  // count against the measured delta.
  fs.cpSync(join(basename, "from"), join(basename, "warmup"), { recursive: true });

  const before = handleCount();
  fs.cpSync(join(basename, "from"), join(basename, "result"), { recursive: true });
  const after = handleCount();

  // Without the fix every symlink leaks a handle, so `after - before` is >= N.
  // With the fix the delta is ~0; allow generous slack for unrelated background
  // activity while still catching a per-symlink leak.
  expect(after - before).toBeLessThan(N / 2);
});

// Junctions are the one link type Windows lets unprivileged processes create, so
// node_modules trees from npm/pnpm/bun contain them. cpSync must copy them as
// links (Node's dereference:false default), and creating the copied link must not
// require symlink privilege (junction fallback).
test.skipIf(!isWindows)("cpSync recursive copies a junction as a link to the original target", () => {
  using basename = tempDir("cp-junction", {
    "from/real/inner.txt": "inner",
  });
  fs.symlinkSync(join(basename, "from", "real"), join(basename, "from", "junction"), "junction");

  fs.cpSync(join(basename, "from"), join(basename, "result"), { recursive: true });

  const copied = join(basename, "result", "junction");
  expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true);
  // Pin the stored link target, not just that creation succeeded: a relative or
  // otherwise wrong target still produces a link that lstat reports as a symlink.
  const copiedTarget = fs.readlinkSync(copied);
  expect(isAbsolute(copiedTarget)).toBe(true);
  expect(fs.realpathSync(copiedTarget)).toBe(fs.realpathSync(join(basename, "from", "real")));
  expect(fs.realpathSync(copied)).toBe(fs.realpathSync(join(basename, "from", "real")));
  expect(fs.readFileSync(join(copied, "inner.txt"), "utf8")).toBe("inner");
});

// `GetFinalPathNameByHandleW(VOLUME_NAME_DOS)` spells targets on a network share as
// `\\?\UNC\server\share\...`. The copied link's target must come out as the absolute
// `\\server\share\...` form (libuv `fs__realpath_handle`), not a dangling relative path.
test.skipIf(!isWindows)("cpSync recursive copies a directory symlink to a UNC target as a working link", () => {
  using basename = tempDir("cp-unc-link", {
    "from/keep.txt": "keep",
    "real/inner.txt": "inner",
  });
  // Administrative-share spelling of `real`, like the "windows path handling"
  // suite in fs.test.ts relies on.
  const real = fs.realpathSync(join(basename, "real"));
  const uncReal = `\\\\localhost\\${real[0]}$\\${real.slice(3)}`;
  expect(fs.readFileSync(join(uncReal, "inner.txt"), "utf8")).toBe("inner");
  fs.symlinkSync(uncReal, join(basename, "from", "link"), "dir");

  fs.cpSync(join(basename, "from"), join(basename, "result"), { recursive: true });

  const copied = join(basename, "result", "link");
  expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true);
  const copiedTarget = fs.readlinkSync(copied);
  expect(isAbsolute(copiedTarget)).toBe(true);
  expect(copiedTarget).toStartWith("\\\\");
  expect(fs.readFileSync(join(copied, "inner.txt"), "utf8")).toBe("inner");
});

// On Windows the OS path buffer is 32768 wide chars, which is impractical to exceed
// with on-disk directories, so this test targets POSIX where MAX_PATH_BYTES is small
// enough to reach via relative mkdir + chdir.
describe.skipIf(isWindows).each(["cp", "cpSync"] as const)(
  "fs.%s recursive returns ENAMETOOLONG instead of overflowing path buffer",
  which => {
    test(which, async () => {
      using dir = tempDir("cp-enametoolong", { s: {}, d: {} });
      const base = String(dir);
      const src = join(base, "s");
      const dst = join(base, "d");

      // Build a directory tree whose full path exceeds MAX_PATH_BYTES by creating each
      // level with a short relative path from a shell; the kernel never sees the whole
      // path so it never rejects it. We do this in /bin/sh rather than via process.chdir
      // so the test process's cwd is unaffected.
      //
      // The same tree is mirrored under dst so that on macOS — where both cpSyncInner and
      // _cpAsyncDirectory retry clonefile() at every recursion level — clonefile hits
      // EEXIST at every level and falls through to the manual iteration path containing
      // the bounds check (clonefile would otherwise clone the whole subtree at the vnode
      // level without ever building interior path strings).
      const seg = Buffer.alloc(200, "a").toString();
      for (const root of [src, dst]) {
        await using mktree = Bun.spawn({
          cmd: [
            "/bin/sh",
            "-c",
            `cd "$1" && i=0 && while [ $i -lt 64 ]; do mkdir "$2" && cd "$2" || exit 0; i=$((i+1)); done`,
            "sh",
            root,
            seg,
          ],
          env: bunEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        await mktree.exited;
      }

      // Run the cp in a subprocess: before the fix this corrupts the stack and segfaults.
      const script = `
        const fs = require("fs");
        const src = ${JSON.stringify(src)};
        const dst = ${JSON.stringify(dst)};
        const done = e => {
          if (e && e.code === "ENAMETOOLONG") {
            console.log("ENAMETOOLONG");
          } else if (e) {
            console.log("ERR:" + (e.code || e.message));
          } else {
            console.log("OK");
          }
        };
        if (${JSON.stringify(which)} === "cpSync") {
          try { fs.cpSync(src, dst, { recursive: true }); done(); } catch (e) { done(e); }
        } else {
          fs.promises.cp(src, dst, { recursive: true }).then(() => done(), done);
        }
      `;
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", script],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe("ENAMETOOLONG");
      expect(exitCode).toBe(0);
    });
  },
);

// fs.promises.cp recursive: when one SingleTask copy fails while siblings are
// still in flight on the thread pool, the parent AsyncCpTask must not be
// destroyed until every subtask has dropped its reference. Before the fix,
// the failing subtask enqueued runFromJSThread immediately and the JS thread
// freed the parent while other subtasks were still dereferencing it
// (heap-use-after-free under ASAN).
//
// POSIX-only: uses a pre-existing directory at the destination path of one
// file so that its SingleTask fails with EISDIR. This works even when running
// as root. On macOS the pre-existing dst/ makes clonefile() fail with EEXIST
// and fall through to the per-file SingleTask path being tested.
test.skipIf(!isPosix)(
  "fs.promises.cp recursive does not free parent task while subtasks are in flight after an error",
  async () => {
    const files: DirectoryTree = {};
    // Enough siblings so several SingleTasks are running on the thread pool
    // when the failing one errors.
    for (let i = 0; i < 32; i++) files[`src/f${i}.txt`] = "x";
    files["src/000-bad.txt"] = "x";
    // The destination for 000-bad.txt is a directory → copying into it fails.
    files["dst/000-bad.txt"] = { ".keep": "" };
    using dir = tempDir("cp-uaf", files);
    const base = String(dir);

    // Run the copy in a subprocess: before the fix this is a
    // heap-use-after-free that ASAN aborts on. The subprocess loops to make
    // the race reliable. It must reject with EISDIR each iteration and exit 0.
    const script = `
      const fs = require("fs");
      const path = require("path");
      const base = ${JSON.stringify(base)};
      const src = path.join(base, "src");
      const dst = path.join(base, "dst");
      (async () => {
        for (let i = 0; i < 20; i++) {
          try {
            await fs.promises.cp(src, dst, { recursive: true });
            console.log("UNEXPECTED-SUCCESS");
            process.exit(1);
          } catch (e) {
            if (e?.code !== "ERR_FS_CP_NON_DIR_TO_DIR") {
              console.log("UNEXPECTED-ERROR:" + (e?.code ?? e?.message));
              process.exit(1);
            }
          }
        }
        console.log("ok");
      })();
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", script],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("ok");
    expect(exitCode).toBe(0);
  },
);

test.skipIf(!isLinux)("fs.cp and fs.copyFile create the destination with the source file's mode", async () => {
  using dir = tempDir("cp-dest-mode", {});
  const destNames = ["dest-copyFile.bin", "dest-cp.bin"];
  const src = join(String(dir), "src.bin");
  fs.writeFileSync(src, "", { mode: 0o600 });
  fs.truncateSync(src, 1 << 26);
  fs.chmodSync(src, 0o600);

  const modeAtCreation = new Map<string, string>();
  const { promise: allCreated, resolve: onAllCreated, reject: onWatchError } = Promise.withResolvers<void>();
  const watcher = fs.watch(String(dir), (_event, filename) => {
    if (typeof filename !== "string" || !filename.startsWith("dest-") || modeAtCreation.has(filename)) {
      return;
    }
    try {
      modeAtCreation.set(filename, (fs.statSync(join(String(dir), filename)).mode & 0o777).toString(8));
    } catch (err) {
      onWatchError(err);
      return;
    }
    if (modeAtCreation.size === destNames.length) {
      onAllCreated();
    }
  });
  using _watcher = { [Symbol.dispose]: () => watcher.close() };
  watcher.on("error", onWatchError);

  const script = `
    const fs = require("node:fs");
    process.umask(0o022);
    fs.copyFileSync("src.bin", "dest-copyFile.bin");
    fs.cpSync("src.bin", "dest-cp.bin");
  `;
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: {
      ...bunEnv,
      BUN_CONFIG_DISABLE_ioctl_ficlonerange: "1",
      BUN_CONFIG_DISABLE_COPY_FILE_RANGE: "1",
    },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
    allCreated,
  ]);
  const finalMode = (name: string) => (fs.statSync(join(String(dir), name)).mode & 0o777).toString(8);
  expect({
    atCreation: Object.fromEntries(modeAtCreation),
    final: Object.fromEntries(destNames.map(name => [name, finalMode(name)])),
  }).toEqual({
    atCreation: { "dest-copyFile.bin": "600", "dest-cp.bin": "600" },
    final: { "dest-copyFile.bin": "600", "dest-cp.bin": "600" },
  });
  expect(stdout).toBe("");
  expect(exitCode).toBe(0);
});
