import type { CommandSchema, CommandsSchema } from '@tutorialkit/types';

export class Commands implements Iterable<Command> {
  /**
   * List of commands executed before the main command.
   */

  readonly prepareCommands?: Command[];

  /**
   * Main command to run. Typically a dev server, e.g. `npm run start`.
   */
  readonly mainCommand?: Command;

  constructor({ prepareCommands, mainCommand }: CommandsSchema) {
    this.prepareCommands = prepareCommands?.map((command) => new Command(command));
    this.mainCommand = mainCommand ? new Command(mainCommand) : undefined;
  }

  [Symbol.iterator]() {
    const _this = this;

    return (function* () {
      for (const command of _this.prepareCommands ?? []) {
        yield command;
      }

      if (_this.mainCommand) {
        yield _this.mainCommand;
      }
    })();
  }
}

export class Command {
  /**
   * The underlying shell command.
   */
  readonly shellCommand: string;

  /** Titles describing what this command does, e.g., "Installing dependencies". */
  readonly titles: readonly string[];

  /** A deterministic initial title so server and client hydration agree. */
  readonly title: string;

  constructor(command: CommandSchema) {
    this.shellCommand = Command.toShellCommand(command);
    this.titles = Command.toTitles(command);
    this.title = this.titles[0] ?? '';
  }

  /** Choose a playful label only when the client starts the command. */
  pickTitle(): string {
    return this.titles[Math.floor(Math.random() * this.titles.length)] ?? this.title;
  }

  isRunnable() {
    return this.shellCommand !== '';
  }

  static equals(a: Command, b: Command) {
    return a.shellCommand === b.shellCommand;
  }

  static toTitles(command: CommandSchema): string[] {
    const title = typeof command === 'string' ? command : Array.isArray(command) ? command[1] : command.title;
    return typeof title === 'string' ? [title] : title;
  }

  static toTitle(command: CommandSchema): string {
    return Command.toTitles(command)[0] ?? '';
  }

  static toShellCommand(command: CommandSchema) {
    if (typeof command === 'string') {
      return command;
    }

    if (Array.isArray(command)) {
      return command[0];
    }

    return command.command;
  }
}
