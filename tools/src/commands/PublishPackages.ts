import { Command } from '@expo/commander';
import chalk from 'chalk';
import * as jsondiffpatch from 'jsondiffpatch';
import path from 'path';

import { EXPO_DIR } from '../Constants';
import Git from '../Git';
import logger from '../Logger';
import { getListOfPackagesAsync } from '../Packages';
import { TaskRunner, Task, TasksRunnerBackup } from '../TasksRunner';
import { PackagesGraph } from '../packages-graph';
import { BACKUP_PATH, BACKUP_EXPIRATION_TIME } from '../publish-packages/constants';
import { pickBackupableOptions, shouldUseBackupAsync } from '../publish-packages/helpers';
import { checkPackagesIntegrity } from '../publish-packages/tasks/checkPackagesIntegrity';
import { grantTeamAccessToPackages } from '../publish-packages/tasks/grantTeamAccessToPackages';
import { listUnpublished } from '../publish-packages/tasks/listUnpublished';
import { getCachedParcel } from '../publish-packages/tasks/loadRequestedParcels';
import { publishCanaryPipeline } from '../publish-packages/tasks/publishCanary';
import { publishPackagesPipeline } from '../publish-packages/tasks/publishPackagesPipeline';
import { CommandOptions, Parcel, TaskArgs, PublishBackupData } from '../publish-packages/types';

export default (program: Command) => {
  program
    .command('publish-packages [packageNames...]')
    .alias('pub-pkg', 'publish', 'pp')
    .option(
      '-p, --prerelease [prereleaseIdentifier]',
      'Publish packages as prerelease versions. Prerelease identifier can be customized, defaults to `rc` if not provided.',
      false
    )
    .option(
      '-t, --tag <tag>',
      'Tag to pass to `npm publish` command. Defaults to `next`. Use `latest` only if you are sure to start distributing packages immediately.',
      'next'
    )
    .option(
      '-r, --retry',
      `Retries previous command run using the backup saved before the task at which the process has stopped. Some other options and arguments must stay the same.`,
      false
    )
    .option(
      '-m, --commit-message <commitMessage>',
      'Customizes publish commit message. It is auto-generated by default.'
    )
    .option(
      '-f, --force',
      "Whether to force publishing packages when they don't have any changes.",
      false
    )
    .option('--no-deps', 'Whether not to include dependencies of the requested packages', false)

    /* exclusive options */
    .option(
      '-l, --list-unpublished',
      'Lists packages with unpublished changes since the previous version.',
      false
    )
    .option(
      '-g, --grant-access',
      'Grants organization team access to packages in which someone from the team is not included as package maintainer.',
      false
    )
    .option(
      '-c, --check-integrity',
      'Checks integrity of packages. These checks must pass to clearly identify changes that have been made since previous publish.',
      false
    )
    .option('-C, --canary', 'Whether to publish all packages as canary versions.', false)

    /* debug options */
    .option(
      '-S, --skip-repo-checks',
      'Skips checking whether the command is run on main branch and there are no unstaged changes.',
      false
    )
    .option(
      '-D, --dry',
      'Whether to skip pushing publish commit to remote repo and run `npm publish` in dry mode. Despite this, some files might be changed and committed.',
      false
    )

    .description(
      // prettier-ignore
      `This script publishes packages within the monorepo and takes care of bumping version numbers,
updating other workspace projects, committing and pushing changes to remote repo.

As it's prone to errors due to its complexity and the fact it sometimes may take some time, we made it stateful.
It's been splitted into a few tasks after each a backup is saved under ${chalk.magenta.bold(path.relative(EXPO_DIR, BACKUP_PATH))} file
and all file changes they made are added to Git's index as part of the backup. Due to its stateful nature,
your local repo must be clear (without unstaged changes) and you shouldn't make any changes in the repo while the command is running.

In case of any errors or mistakes you can always go back to the previous phase by running the exact same command again,
but remember to leave staged changes as they were because they're also part of the backup.`
    )
    .usage(
      `

To list packages with unpublished changes:
${chalk.gray('>')} ${chalk.italic.cyan('et publish -l')}

To publish all packages with unpublished changes:
${chalk.gray('>')} ${chalk.italic.cyan('et publish')}

To publish just specific packages and their dependencies:
${chalk.gray('>')} ${chalk.italic.cyan('et publish expo-gl expo-auth-session')}`
    )
    .asyncAction(main);
};

/**
 * Main action of the command. Goes through appropriate tasks, based on command options.
 */
async function main(packageNames: string[], options: CommandOptions): Promise<void> {
  // Commander doesn't put arguments to options object, let's add it for convenience. In fact, this is an option.
  options.packageNames = packageNames;

  const tasks = tasksForOptions(options);
  const taskRunner = new TaskRunner<TaskArgs, PublishBackupData>({
    tasks,
    backupFilePath: BACKUP_PATH,
    backupExpirationTime: BACKUP_EXPIRATION_TIME,

    /**
     * Backup is valid if current head commit hash is the same as from the time where the backup was saved,
     * and there is no difference in command options.
     */
    async validateBackup(backup): Promise<boolean> {
      const headCommitHash = await Git.getHeadCommitHashAsync();

      return (
        backup.data &&
        headCommitHash === backup.data.head &&
        !jsondiffpatch.diff(pickBackupableOptions(options), backup.data.options)
      );
    },

    /**
     * At this point a backup is valid but we can discard it if `--retry` option wasn't provided.
     */
    async shouldUseBackup(): Promise<boolean> {
      return await shouldUseBackupAsync(options);
    },

    /**
     * Provides backup data for task runner.
     */
    async createBackupData(task, parcels, options): Promise<PublishBackupData> {
      const data = {
        options: pickBackupableOptions(options),
        head: await Git.getHeadCommitHashAsync(),
        state: {},
      };

      for (const { pkg, state } of parcels) {
        data.state[pkg.packageName] = JSON.parse(JSON.stringify(state));
      }
      return data;
    },

    /**
     * Applies given backup to parcels array.
     */
    async restoreBackup(
      backup: TasksRunnerBackup<PublishBackupData>,
      parcels: Parcel[]
    ): Promise<void> {
      const dateString = new Date(backup.timestamp).toLocaleString();

      logger.info(`♻️  Restoring from backup saved on ${chalk.magenta(dateString)}...`);

      const allPackages = await getListOfPackagesAsync();
      const graph = new PackagesGraph(allPackages);

      for (const [packageName, restoredState] of Object.entries(backup.data!.state)) {
        const node = graph.getNode(packageName);

        if (node) {
          const parcel = await getCachedParcel(node);
          parcel.state = { ...parcel.state, ...restoredState };
          parcels.push(parcel);
        }
      }
    },

    /**
     * Method that is called once existing backup is no longer valid.
     */
    backupValidationFailed() {
      logger.warn(
        `⚠️  Found backup file but you've run the command with different options. Continuing from scratch...`
      );
    },
  });

  await taskRunner.runAndExitAsync([], options);
}

/**
 * Returns target task instances based on provided command options.
 */
function tasksForOptions(options: CommandOptions): Task<TaskArgs>[] {
  if (options.listUnpublished) {
    return [listUnpublished];
  }
  if (options.grantAccess) {
    return [grantTeamAccessToPackages];
  }
  if (options.checkIntegrity) {
    return [checkPackagesIntegrity];
  }
  if (options.canary) {
    return [publishCanaryPipeline];
  }
  return [publishPackagesPipeline];
}
