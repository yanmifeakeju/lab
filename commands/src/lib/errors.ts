/**
 * Errors thrown by the commands library.
 */

/**
 * CommandNotFoundError is thrown when execute() is called with a name 
 * that hasn't been registered.
 */
export class CommandNotFoundError extends Error {
  constructor(public readonly commandName: string) {
    super(`Command not found: ${commandName}`);
    this.name = "CommandNotFoundError";
  }
}

/**
 * CommandAlreadyExistsError is thrown when add() is called with a name 
 * that is already in the registry.
 */
export class CommandAlreadyExistsError extends Error {
  constructor(public readonly commandName: string) {
    super(`Command already exists: ${commandName}`);
    this.name = "CommandAlreadyExistsError";
  }
}

/**
 * CommandValidationError is thrown when the input data fails validation 
 * against the command's schema.
 */
export class CommandValidationError extends Error {
  constructor(
    public readonly commandName: string,
    public readonly issues: string[],
  ) {
    super(
      `Validation failed for command "${commandName}": ${issues.join("; ")}`,
    );
    this.name = "CommandValidationError";
  }
}

/**
 * CommandRegistrationError is thrown when a command definition is 
 * malformed during registration.
 */
export class CommandRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRegistrationError";
  }
}
