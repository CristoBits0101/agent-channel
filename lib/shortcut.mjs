// Writes a Windows shortcut (.lnk) directly, following Microsoft's Shell Link format [MS-SHLLINK],
// so the installer needs no PowerShell, VBScript or COM. The link stores the target as an absolute
// local path (LinkInfo), plus working folder, arguments, icon and window state.
import { writeFileSync } from 'node:fs';

const utf16 = text => Buffer.from(`${text}\0`, 'utf16le');
// ANSI copy of the path for old readers; characters outside Latin-1 become '?'. Windows reads the Unicode copy.
const ansi = text => Buffer.from(`${text.replace(/[^\x00-\xff]/g, '?')}\0`, 'latin1');
const counted = text => {
  const size = Buffer.alloc(2);
  size.writeUInt16LE(text.length);
  return Buffer.concat([size, Buffer.from(text, 'utf16le')]);
};

function header(flags, showCommand) {
  const buffer = Buffer.alloc(76);
  buffer.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(buffer, 4); // CLSID 00021401-0000-0000-C000-000000000046
  buffer.writeUInt32LE(flags, 20);
  buffer.writeUInt32LE(0x20, 24); // FILE_ATTRIBUTE_ARCHIVE
  buffer.writeUInt32LE(showCommand, 60);
  return buffer;
}

function linkInfo(target) {
  const volume = Buffer.alloc(17);
  volume.writeUInt32LE(17, 0);
  volume.writeUInt32LE(3, 4); // DRIVE_FIXED
  volume.writeUInt32LE(0x10, 12); // empty label right after the fields
  const base = ansi(target);
  const suffix = Buffer.from([0]);
  const baseUnicode = utf16(target);
  const suffixUnicode = Buffer.alloc(2);
  const headerSize = 0x24;
  const volumeOffset = headerSize;
  const baseOffset = volumeOffset + volume.length;
  const suffixOffset = baseOffset + base.length;
  const baseUnicodeOffset = suffixOffset + suffix.length;
  const suffixUnicodeOffset = baseUnicodeOffset + baseUnicode.length;
  const size = suffixUnicodeOffset + suffixUnicode.length;
  const fields = Buffer.alloc(headerSize);
  [size, headerSize, 1, volumeOffset, baseOffset, 0, suffixOffset, baseUnicodeOffset, suffixUnicodeOffset]
    .forEach((value, index) => fields.writeUInt32LE(value, index * 4));
  return Buffer.concat([fields, volume, base, suffix, baseUnicode, suffixUnicode]);
}

const u16 = value => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const item = data => Buffer.concat([u16(data.length + 2), data]);

// One folder or file of the path: a short entry plus the BEEF0004 extension with the long Unicode name.
function pathItem(name, isFolder) {
  let primary = ansi(name);
  const head = Buffer.alloc(12);
  head[0] = isFolder ? 0x31 : 0x32;
  head.writeUInt16LE(isFolder ? 0x10 : 0x20, 10); // FILE_ATTRIBUTE_DIRECTORY or ARCHIVE
  if ((2 + head.length + primary.length) % 2) primary = Buffer.concat([primary, Buffer.alloc(1)]);
  const extensionOffset = 2 + head.length + primary.length;
  const longName = utf16(name);
  const extensionBody = Buffer.concat([u16(3), Buffer.from([0x04, 0x00, 0xef, 0xbe]), Buffer.alloc(8), u16(0x14), u16(0), longName, u16(extensionOffset)]);
  return item(Buffer.concat([head, primary, u16(extensionBody.length + 2), extensionBody]));
}

// LinkTargetIDList: My Computer → drive → each folder → file. This is what Explorer shows as the target.
function idList(target) {
  const [drive, ...parts] = target.split(/[\\/]+/).filter(Boolean);
  if (!/^[a-z]:$/i.test(drive)) throw new Error(`Shortcuts need a local drive path: ${target}`);
  const computer = item(Buffer.concat([Buffer.from([0x1f, 0x50]), Buffer.from('e04fd020ea3a6910a2d808002b30309d', 'hex')]));
  const driveData = Buffer.alloc(23);
  driveData[0] = 0x2f;
  driveData.write(`${drive.toUpperCase()}\\`, 1, 'latin1');
  const items = [computer, item(driveData), ...parts.map((part, index) => pathItem(part, index < parts.length - 1)), Buffer.alloc(2)];
  const body = Buffer.concat(items);
  return Buffer.concat([u16(body.length), body]);
}

// EnvironmentVariableDataBlock: the target again, which the shell resolves first.
function targetBlock(target) {
  const block = Buffer.alloc(0x314);
  block.writeUInt32LE(0x314, 0);
  block.writeUInt32LE(0xa0000001, 4);
  ansi(target).subarray(0, 259).copy(block, 8);
  utf16(target).subarray(0, 518).copy(block, 268);
  return block;
}

/**
 * @param {string} file .lnk path to write
 * @param {{ target: string, arguments?: string, workingDirectory?: string, icon?: string, description?: string, minimized?: boolean }} link
 */
export function writeShortcut(file, link) {
  const HAS_LINK_INFO = 0x2, HAS_NAME = 0x4, HAS_WORKING_DIR = 0x10, HAS_ARGUMENTS = 0x20, HAS_ICON = 0x40, IS_UNICODE = 0x80;
  const HAS_EXP_STRING = 0x200;
  if (link.target.length > 259) throw new Error(`Path too long for a shortcut: ${link.target}`);
  const HAS_ID_LIST = 0x1;
  let flags = HAS_ID_LIST | HAS_LINK_INFO | IS_UNICODE | HAS_EXP_STRING;
  const strings = [];
  if (link.description) { flags |= HAS_NAME; strings.push(counted(link.description)); }
  if (link.workingDirectory) { flags |= HAS_WORKING_DIR; strings.push(counted(link.workingDirectory)); }
  if (link.arguments) { flags |= HAS_ARGUMENTS; strings.push(counted(link.arguments)); }
  if (link.icon) { flags |= HAS_ICON; strings.push(counted(link.icon)); }
  const showCommand = link.minimized ? 7 : 1; // SW_SHOWMINNOACTIVE or SW_SHOWNORMAL
  writeFileSync(file, Buffer.concat([header(flags, showCommand), idList(link.target), linkInfo(link.target), ...strings, targetBlock(link.target), Buffer.alloc(4)]));
}
