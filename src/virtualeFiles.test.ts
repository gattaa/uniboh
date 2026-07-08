import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFileListing,
  classifyContentType,
  filenameFromContentDisposition,
  resourceViewPath
} from "./virtualeFiles.js";

test("resourceViewPath builds the resource view URL from a cmid", () => {
  assert.equal(resourceViewPath(2314723), "/mod/resource/view.php?id=2314723");
});

test("buildFileListing keeps only file/resource cms, grouped per section", () => {
  const state = {
    course: { id: 74014 },
    section: [
      { id: 744365, title: "Introduction", cmlist: [2314721, 2314722, 2314723] },
      { id: 744366, title: "Empty", cmlist: [2314799] }
    ],
    cm: [
      { id: 2314721, name: "News forum", module: "forum", url: "/mod/forum/view.php?id=2314721" },
      { id: 2314722, name: "Course link", module: "url", url: "/mod/url/view.php?id=2314722" },
      { id: 2314723, name: "Introduction - PDF copy", module: "resource", url: "/mod/resource/view.php?id=2314723" },
      { id: 2314799, name: "Slides", module: "page", url: "/mod/page/view.php?id=2314799" }
    ]
  };

  const listing = buildFileListing(state);
  assert.equal(listing.courseId, 74014);
  assert.equal(listing.totalFiles, 1);
  assert.equal(listing.sections.length, 1);

  const section = listing.sections[0];
  assert.equal(section.sectionId, 744365);
  assert.equal(section.title, "Introduction");
  assert.equal(section.files.length, 1);
  assert.deepEqual(section.files[0], {
    cmid: 2314723,
    name: "Introduction - PDF copy",
    modname: "resource",
    url: "/mod/resource/view.php?id=2314723"
  });
});

test("buildFileListing also classifies by url when the module field is absent", () => {
  const state = {
    section: [{ id: 1, title: "S", cmlist: [10] }],
    cm: [{ id: 10, name: "Notes", url: "https://virtuale.unibo.it/mod/resource/view.php?id=10" }]
  };
  const listing = buildFileListing(state);
  assert.equal(listing.totalFiles, 1);
  assert.equal(listing.sections[0].files[0].cmid, 10);
});

test("buildFileListing tolerates missing/empty state", () => {
  const listing = buildFileListing(undefined);
  assert.equal(listing.totalFiles, 0);
  assert.deepEqual(listing.sections, []);
  assert.equal(listing.courseId, undefined);
});

test("filenameFromContentDisposition reads a quoted filename", () => {
  assert.equal(
    filenameFromContentDisposition('inline; filename="Introduction.pdf"'),
    "Introduction.pdf"
  );
});

test("filenameFromContentDisposition reads a bare (unquoted) filename", () => {
  assert.equal(filenameFromContentDisposition("attachment; filename=notes.txt"), "notes.txt");
});

test("filenameFromContentDisposition decodes the RFC 5987 filename* form", () => {
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''lezione%2001.pdf"),
    "lezione 01.pdf"
  );
});

test("filenameFromContentDisposition falls back to the URL path basename", () => {
  assert.equal(
    filenameFromContentDisposition(undefined, "https://virtuale.unibo.it/pluginfile.php/3001131/mod_resource/content/3/Introduction.pdf"),
    "Introduction.pdf"
  );
  assert.equal(
    filenameFromContentDisposition(null, "https://virtuale.unibo.it/pluginfile.php/1/x/My%20Slides.pptx"),
    "My Slides.pptx"
  );
});

test("filenameFromContentDisposition defaults to 'download' with no hints", () => {
  assert.equal(filenameFromContentDisposition(undefined, "https://virtuale.unibo.it/"), "download");
});

test("classifyContentType flags text-like content types", () => {
  for (const ct of [
    "text/plain; charset=utf-8",
    "text/html",
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "image/svg+xml"
  ]) {
    assert.equal(classifyContentType(ct).textLike, true, `${ct} should be text-like`);
  }
});

test("classifyContentType flags PDFs and non-text binaries", () => {
  const pdf = classifyContentType("application/pdf");
  assert.equal(pdf.isPdf, true);
  assert.equal(pdf.textLike, false);

  const png = classifyContentType("image/png");
  assert.equal(png.textLike, false);
  assert.equal(png.isPdf, false);
  assert.equal(png.isHtml, false);
});

test("classifyContentType marks HTML separately (for login-page detection)", () => {
  assert.equal(classifyContentType("text/html; charset=UTF-8").isHtml, true);
  assert.equal(classifyContentType("application/pdf").isHtml, false);
});
