import z from "zod";

// abstract class CommandsError extends Error {
//   abstract schema(): z.core.$ZodType;
//   abstract toObject(): { name: string; metadata: any };

//   static create<Name extends string, Metadata extends z.core.$ZodType>(
//     name: Name,
//     metadata: Metadata,
//   ) {
//     const schema = z
//       .object({
//         name: z.literal(name),
//         data: metadata,
//       })
//       .meta({
//         ref: name,
//       });
//     const result = class extends CommandsError {
//       public static readonly Schema = schema;

//       public override readonly name = name as Name;

//       constructor(
//         public readonly data: z.input<Metadata>,
//         options?: ErrorOptions,
//       ) {
//         super(name, options);
//         this.name = name;
//       }

//       static isInstance(input: any): input is InstanceType<typeof result> {
//         return (
//           typeof input === "object" && "name" in input && input.name === name
//         );
//       }

//       schema() {
//         return schema;
//       }

//       toObject() {
//         return {
//           name: name,
//           metadata: this.data,
//         };
//       }
//     };
//     Object.defineProperty(result, "name", { value: name });
//     return result;
//   }

//   public static readonly Unknown = CommandsError.create(
//     "UnknownError",
//     z.object({
//       message: z.string(),
//     }),
//   );
// }

export class CommandNotFoundError extends Error {
  constructor(public readonly commandName: string) {
    super(`Command not found: ${commandName}`);
    this.name = "CommandNotFoundError";
  }
}

export class CommandAlreadyExistsError extends Error {
  constructor(public readonly commandName: string) {
    super(`Command already exists: ${commandName}`);
    this.name = "CommandAlreadyExistsError";
  }
}

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

export class CommandRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRegistrationError";
  }
}
