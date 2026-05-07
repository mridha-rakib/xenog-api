import type { ZodError, ZodIssue } from "zod";

export interface FormattedZodIssue {
  path: string;
  field: string;
  location: string;
  message: string;
  code: ZodIssue["code"];
}

export interface FormattedZodError {
  issues: FormattedZodIssue[];
  fields: Record<string, string[]>;
}

const getPathParts = (issue: ZodIssue): string[] => issue.path.map((part) => String(part));

export const formatZodError = (error: ZodError): FormattedZodError => {
  const issues = error.issues.map((issue) => {
    const pathParts = getPathParts(issue);
    const [location = "unknown", ...fieldParts] = pathParts;
    const path = pathParts.join(".");
    const field = fieldParts.join(".") || path || "unknown";

    return {
      path,
      field,
      location,
      message: issue.message,
      code: issue.code,
    };
  });

  const fields = issues.reduce<Record<string, string[]>>((accumulator, issue) => {
    const messages = accumulator[issue.path] ?? [];
    messages.push(issue.message);
    accumulator[issue.path] = messages;

    return accumulator;
  }, {});

  return {
    issues,
    fields,
  };
};
