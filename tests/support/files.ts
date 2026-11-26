// Minimal byte signatures for test files.
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body")]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
export const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
export const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fake zip body")]);
export const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("fake ole")]);
export const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
export const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]);
export const SCRIPT = Buffer.from("#!/bin/sh\nrm -rf /\n");
export const TEXT = Buffer.from("plain log line\nsecond line\n");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
