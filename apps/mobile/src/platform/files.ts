import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Lets the person pick statement files from Files. iOS hands the app a copy in its cache; each is read into memory
 * and the copy is deleted straight away, so no statement file stays behind in the app.
 */
export async function pickStatementFiles(): Promise<PickedFile[]> {
  const result = await getDocumentAsync({
    type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text', '*/*'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  const files: PickedFile[] = [];
  for (const asset of result.assets) {
    const file = new File(asset.uri);
    try {
      files.push({ name: asset.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    } finally {
      try {
        file.delete();
      } catch {
        // iOS clears the cache folder itself.
      }
    }
  }
  return files;
}
