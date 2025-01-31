import { getConfig } from '@expo/config';
import path from 'path';

import { getProjectPackageJsonPathAsync } from './mergeLinkingOptions';

interface AndroidMavenRepository {
  url: string;
}

interface IosPod {
  name: string;
  version?: string;
  configurations?: string[];
  modular_headers?: boolean;
  source?: string;
  path?: string;
  podspec?: string;
  testspecs?: string[];
  git?: string;
  branch?: string;
  tag?: string;
  commit?: string;
}

interface ExtraDependencies {
  androidMavenRepos: AndroidMavenRepository[];
  iosPods?: IosPod[];
}

/**
 * Gets the `expo-build-properties` settings from the app config.
 */
export async function getBuildPropertiesAsync(projectRoot: string): Promise<Record<string, any>> {
  const projectPackageRoot = path.dirname(await getProjectPackageJsonPathAsync(projectRoot));
  const { exp: config } = await getConfig(projectPackageRoot, { skipSDKVersionRequirement: true });
  const buildPropertiesPlugin = config.plugins?.find(
    (item) => item[0] === 'expo-build-properties'
  )?.[1];
  return buildPropertiesPlugin ?? {};
}

/**
 * Resolves the extra dependencies from `expo-build-properties` settings.
 */
export async function resolveExtraDependenciesAsync(
  projectRoot: string
): Promise<Partial<ExtraDependencies>> {
  const buildProps = await getBuildPropertiesAsync(projectRoot);
  return {
    androidMavenRepos: buildProps.android?.extraMavenRepos ?? [],
    iosPods: buildProps.ios?.extraPods ?? {},
  };
}
