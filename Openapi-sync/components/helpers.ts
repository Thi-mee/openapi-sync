import { IOpenApiSpec, IOpenApSchemaSpec } from "../types";
import { variableNameChar } from "./regex";
import * as yaml from "js-yaml";
import lodash from "lodash";

export const isJson = (value: any): value is object => {
  return typeof value === "object" && value !== null && !(value instanceof Blob);
};

export const isYamlString = (fileContent: string) => {
  try {
    yaml.load(fileContent);
    return true;
  } catch (en) {
    const e = en as any;
    if (e instanceof yaml.YAMLException) {
      return false;
    } else {
      throw e;
    }
  }
};

export const yamlStringToJson = (fileContent: string) => {
  if (isYamlString(fileContent)) {
    const content = yaml.load(fileContent);

    const jsonString = JSON.stringify(content, null, 2);
    const json = JSON.parse(jsonString);
    return json;
  }
};

export const capitalize = (text: string) => {
  const capitalizedWord =
    text.substring(0, 1).toUpperCase() + text.substring(1);
  return capitalizedWord;
};

export const getSharedComponentName = (
  componentName: string,
  componentType?:
    | "parameters"
    | "responses"
    | "schemas"
    | "requestBodies"
    | "headers"
    | "links"
    | "callbacks"
) => `IApi${capitalize(componentName)}`;

export const getEndpointDetails = (path: string, method: string) => {
  const pathParts = path.split("/");
  let name = `${capitalize(method)}`;
  const variables: string[] = [];
  pathParts.forEach((part) => {
    // check if part is a variable
    //api/{userId}
    if (part[0] === "{" && part[part.length - 1] === "}") {
      const s = part.replace(/{/, "").replace(/}/, "");
      variables.push(s);
      part = `$${s}`;
    }

    //api/<userId>
    else if (part[0] === "<" && part[part.length - 1] === ">") {
      const s = part.replace(/</, "").replace(/>/, "");
      variables.push(s);
      part = `$${s}`;
    }

    //api/:userId
    else if (part[0] === ":") {
      const s = part.replace(/:/, "");
      variables.push(s);
      part = `$${s}`;
    }

    // parse to variable name
    let partVal = "";
    part.split("").forEach((char) => {
      let c = char;
      if (!variableNameChar.test(char)) c = "/";
      partVal += c;
    });

    partVal.split("/").forEach((val) => {
      name += capitalize(val);
    });
  });

  return { name, variables, pathParts };
};

const handleRef = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  options?: { noSharedImport?: boolean }
): { type: string; componentName: string; overrideName: string } => {
  let type = "";
  let componentName = "";
  let overrideName = "";

  if (schema.$ref && schema.$ref.startsWith("#")) {
    const pathToComponentParts = schema.$ref.split("/").slice(1);
    const pathToComponent = pathToComponentParts.join(".");
    const component = lodash.get(apiDoc, pathToComponent, null) as IOpenApSchemaSpec;

    if (component) {
      if ((component as any)?.name) {
        overrideName = (component as any).name;
      }
      componentName = pathToComponentParts[pathToComponentParts.length - 1];
      type = `${options?.noSharedImport ? "" : "Shared."}${getSharedComponentName(
        componentName
      )}`;
    }
  }
  // TODO: Handle external $ref (URI)
  return { type, componentName, overrideName };
};

const handleComposition = (
  apiDoc: IOpenApiSpec,
  schemas: IOpenApSchemaSpec[],
  separator: "|" | "&",
  options?: any
): string => {
  return `(${schemas
    .map((v) => parseSchemaToType(apiDoc, v, "", false, options))
    .join(separator)})`;
};

const handleProperties = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  options?: any
): string => {
  if (!schema.properties) {
    return "{[k: string]: any}";
  }
  const objKeys = Object.keys(schema.properties);
  const requiredKeys = schema.required || [];
  let typeCnt = "";

  objKeys.forEach((key) => {
    typeCnt += parseSchemaToType(
      apiDoc,
      schema.properties?.[key] as IOpenApSchemaSpec,
      key,
      requiredKeys.includes(key),
      options
    );
  });

  return typeCnt.length > 0 ? `{\n${typeCnt}}` : "{[k: string]: any}";
};

const handleType = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  options?: any
): string => {
  if (Array.isArray(schema.type)) {
    const types = schema.type
      .filter((t) => t !== "null")
      .map((t) => handleType(apiDoc, { ...schema, type: t }, options));
    return `(${types.join(" | ")})`;
  }

  switch (schema.type) {
    case "integer":
    case "number":
      return "number";
    case "array":
      if (schema.items) {
        return `${parseSchemaToType(apiDoc, schema.items, "", false, options)}[]`;
      }
      return "any[]";
    case "object":
      if (schema.properties) {
        const objKeys = Object.keys(schema.properties);
        const requiredKeys = schema.required || [];
        let typeCnt = "";

        objKeys.forEach((key) => {
          typeCnt += parseSchemaToType(
            apiDoc,
            schema.properties?.[key] as IOpenApSchemaSpec,
            key,
            requiredKeys.includes(key),
            options
          );
        });

        return typeCnt.length > 0 ? `{\n${typeCnt}}` : "{[k: string]: any}";
      }
      if (schema.additionalProperties) {
        return `{[k: string]: ${
          parseSchemaToType(apiDoc, schema.additionalProperties, "", true, options) || "any"
        }}`;
      }
      return "{[k: string]: any}";
    default:
      return schema.type || "string";
  }
};

export const parseSchemaToType = (
  apiDoc: IOpenApiSpec,
  schema: IOpenApSchemaSpec,
  name: string,
  isRequired?: boolean,
  options?: {
    noSharedImport?: boolean;
    useComponentName?: boolean;
  }
): string => {
  if (!schema) {
    return name ? `\t"${name}"${isRequired ? "" : "?"}: string;\n` : "string";
  }

  let type = "";
  let componentName = "";
  let overrideName = "";

  if (schema.$ref) {
    if (schema.$ref.startsWith("#")) {
      const pathToComponentParts = schema.$ref.split("/").slice(1);
      const pathToComponent = pathToComponentParts.join(".");
      const component = lodash.get(apiDoc, pathToComponent, null) as IOpenApSchemaSpec;

      if (component) {
        if ((component as any)?.name) {
          overrideName = (component as any).name;
        }
        componentName = pathToComponentParts[pathToComponentParts.length - 1];
        type = `${options?.noSharedImport ? "" : "Shared."}${getSharedComponentName(
          componentName
        )}`;
      }
    }
    // TODO: Handle external $ref (URI)
  } else if (schema.anyOf) {
    type = `(${schema.anyOf
      .map((v) => parseSchemaToType(apiDoc, v, "", false, options))
      .join(" | ")})`;
  } else if (schema.oneOf) {
    type = `(${schema.oneOf
      .map((v) => parseSchemaToType(apiDoc, v, "", false, options))
      .join(" | ")})`;
  } else if (schema.allOf) {
    type = `(${schema.allOf
      .map((v) => parseSchemaToType(apiDoc, v, "", false, options))
      .join(" & ")})`;
  } else if (schema.enum) {
    type = `(${schema.enum.map((v) => `"${v}"`).join(" | ")})`;
  } else {
    type = handleType(apiDoc, schema, options);
  }

  const finalName = overrideName || name || (options?.useComponentName ? componentName : "");
  const typeName = finalName ? `\t"${finalName}"${isRequired ? "" : "?"}: ` : "";
  const nullable = Array.isArray(schema.type) && schema.type.includes("null") ? " | null" : "";

  return type ? `${typeName}${type}${nullable}${finalName ? ";\n" : ""}` : "";
};