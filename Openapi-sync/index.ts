import fs from "fs";
import path from "path";
import {
  getEndpointDetails,
  getSharedComponentName,
  isJson,
  // isYamlString,
  parseSchemaToType,
  yamlStringToJson,
  // validateTypeContent,
  cleanTypeContent,
  // logValidationErrors,
} from "./components/helpers";
import {
  IConfigReplaceWord,
  IOpenApiMediaTypeSpec,
  IOpenApiParameterSpec,
  IOpenApiRequestBodySpec,
  IOpenApiResponseSpec,
  IOpenApiSpec,
  IOpenApSchemaSpec,
} from "./types";
import { isEqual, get } from "lodash";
import axios from "axios";
import axiosRetry from "axios-retry";
import { bundleFromString, createConfig } from "@redocly/openapi-core";
import { getState, setState } from "./state";

const rootUsingCwd = process.cwd();
let fetchTimeout: Record<string, null | NodeJS.Timeout> = {};

// Create an Axios instance
const apiClient = axios.create({
  timeout: 60000, // Timeout after 1min
});

// Configure axios-retry
axiosRetry(apiClient, {
  retries: 20, // Number of retry attempts
  retryCondition: (error) => {
    // Retry on network error
    return (
      error.code === "ECONNABORTED" || error.message.includes("Network Error")
    );
  },
  retryDelay: (retryCount) => {
    return retryCount * 1000; // Exponential back-off: 1s, 2s, 3s, etc.
  },
});

const OpenapiSync = async (
  apiUrl: string,
  apiName: string,
  refetchInterval?: number
) => {
  const specResponse = await apiClient.get(apiUrl);

  const redoclyConfig = await createConfig({
    extends: ["minimal"],
  });

  const source = JSON.stringify(
    isJson(specResponse.data)
      ? specResponse.data
      : yamlStringToJson(specResponse.data)
  );

  const lintResults = await bundleFromString({
    source,
    config: redoclyConfig,
  });

  // Load config file
  const config = require(path.join(rootUsingCwd, "openapi.sync.json"));
  const folderPath = path.join(config.folder || "", apiName);

  const spec: IOpenApiSpec = lintResults.bundle.parsed as IOpenApiSpec;
  // auto update only on dev
  if (refetchInterval && !isNaN(refetchInterval) && refetchInterval > 0) {
    if (
      !(
        process.env.NODE_ENV &&
        ["production", "prod", "test", "staging"].includes(process.env.NODE_ENV)
      )
    ) {
      // auto sync at interval
      if (fetchTimeout[apiName]) clearTimeout(fetchTimeout[apiName]);

      // set next request timeout
      fetchTimeout[apiName] = setTimeout(
        () => OpenapiSync(apiUrl, apiName, refetchInterval),
        refetchInterval
      );
    }
  }

  // compare new spec with old spec, continuing only if spec it different
  const prevSpec = getState(apiName);
  if (isEqual(prevSpec, spec)) return;

  setState(apiName, spec);

  let endpointsFileContent = "";
  let typesFileContent = "";
  let sharedTypesFileContent: Record<string, string> = {};

  if (spec.components) {
  Object.keys(spec.components).forEach((key) => {
    if (
      [
        "schemas",
        "responses",
        "parameters",
        "examples",
        "requestBodies",
        "headers",
        "links",
        "callbacks",
      ].includes(key)
    ) {
      // Create components (shared) types
      const components: Record<string, any> = spec.components[key];
      const contentKeys = Object.keys(components);
      
      contentKeys.forEach((contentKey) => {
        let typeCnt = "";
        
        if (key === "parameters") {
          // Parameters have a different structure
          const parameter = components[contentKey] as IOpenApiParameterSpec;
          if (parameter.schema) {
            typeCnt = parseSchemaToType(spec, parameter.schema, "", true, {
              noSharedImport: true,
              useComponentName: false,
            });
          } else {
            // Fallback for parameters without schema
            typeCnt = "string";
          }
        } else if (key === "requestBodies") {
          // Handle request bodies properly
          const requestBody = components[contentKey] as IOpenApiRequestBodySpec;
          if (requestBody.$ref) {
            // This is a reference, resolve it
            const refParts = requestBody.$ref.split('/').slice(1);
            const refComponent = get(spec, refParts.join('.'), null);
            if (refComponent) {
              typeCnt = parseSchemaToType(spec, refComponent, "", true, {
                noSharedImport: true,
                useComponentName: false,
              });
            }
          } else if (requestBody.content) {
            // Handle content-based request body
            const contentKeys = Object.keys(requestBody.content);
            if (contentKeys[0] && requestBody.content[contentKeys[0]].schema) {
              typeCnt = parseSchemaToType(
                spec,
                requestBody.content[contentKeys[0]].schema as IOpenApSchemaSpec,
                "",
                true,
                {
                  noSharedImport: true,
                  useComponentName: false,
                }
              );
            }
          }
        } else {
          // Regular component handling
          const schema = (
            components[contentKey]?.schema
              ? components[contentKey].schema
              : components[contentKey]
          ) as IOpenApSchemaSpec;
          
          typeCnt = parseSchemaToType(spec, schema, "", true, {
            noSharedImport: true,
            useComponentName: false,
          });
        }
        
        if (typeCnt && typeCnt.trim()) {
          // Clean up the type content
          const cleanTypeCnt = cleanTypeContent(typeCnt);
          sharedTypesFileContent[key] =
            (sharedTypesFileContent[key] ?? "") +
            `export type ${getSharedComponentName(contentKey)} = ${cleanTypeCnt};\n`;
        }
      });
    }
  });
}

  const getBodySchemaType = (requestBody: IOpenApiRequestBodySpec) => {
    let typeCnt = "";
    if (requestBody.content) {
      const contentKeys = Object.keys(requestBody.content);
      // only need 1 schema so will us the first schema provided
      if (contentKeys[0] && requestBody.content[contentKeys[0]].schema) {
        typeCnt += `${parseSchemaToType(
          spec,
          requestBody.content[contentKeys[0]].schema as IOpenApSchemaSpec,
          ""
        )}`;
      }
    }
    return typeCnt;
  };

  const treatEndpointUrl = (endpointUrl: string) => {
    if (
      config?.endpoints?.value?.replaceWords &&
      Array.isArray(config.endpoints.value.replaceWords)
    ) {
      let newEndpointUrl = endpointUrl;
      config.endpoints.value.replaceWords.forEach(
        (replaceWord: IConfigReplaceWord, indx: string) => {
          const regexp = new RegExp(replaceWord.replace, "g");
          newEndpointUrl = newEndpointUrl.replace(
            regexp,
            replaceWord.with || ""
          );
        }
      );
      return newEndpointUrl;
    } else {
      return endpointUrl;
    }
  };

  Object.keys(spec.paths || {}).forEach((endpointPath) => {
    const endpointSpec = spec.paths[endpointPath];
    const endpointMethods = Object.keys(endpointSpec);
    endpointMethods.forEach((method: string) => {
      const endpoint = getEndpointDetails(endpointPath, method);

      const endpointUrlTxt = endpoint.pathParts
        .map((part) => {
          // check if part is a variable
          if (part[0] === "{" && part[part.length - 1] === "}") {
            const s = part.replace(/{/, "").replace(/}/, "");
            part = `\${${s}}`;
          }

          //api/<userId>
          else if (part[0] === "<" && part[part.length - 1] === ">") {
            const s = part.replace(/</, "").replace(/>/, "");
            part = `\${${s}}`;
          }

          //api/:userId
          else if (part[0] === ":") {
            const s = part.replace(/:/, "");
            part = `\${${s}}`;
          }
          return part;
        })
        .join("/");

      let endpointUrl = `"${endpointUrlTxt}"`;
      if (endpoint.variables.length > 0) {
        const params = endpoint.variables.map((v) => `${v}:string`).join(",");
        endpointUrl = `(${params})=> \`${endpointUrlTxt}\``;
      }

      //treat endpoint url
      endpointUrl = treatEndpointUrl(endpointUrl);

      // Add the endpoint url
      endpointsFileContent += `export const ${endpoint.name} = ${endpointUrl}; 
`;

      if (endpointSpec[method]?.parameters) {
        // create query parameters types
        const parameters: IOpenApiParameterSpec[] =
          endpointSpec[method]?.parameters;
        let typeCnt = "";
        parameters.forEach((param, i) => {
          if (param.$ref || (param.in === "query" && param.name)) {
            typeCnt += `${parseSchemaToType(
              spec,
              param.$ref ? (param as any) : (param.schema as any),
              param.name || "",
              param.required
            )}`;
          }
        });

        if (typeCnt) {
          typesFileContent += `export type I${endpoint.name}Query = {\n${typeCnt}};\n`;
        }
      }

      if (endpointSpec[method]?.requestBody) {
        //create requestBody types
        const requestBody: IOpenApiRequestBodySpec =
          endpointSpec[method]?.requestBody;

        let typeCnt = "";
  
        // Check if requestBody has a $ref
        if (requestBody.$ref) {
          const refParts = requestBody.$ref.split('/').slice(1);
          const componentName = refParts[refParts.length - 1];
          typeCnt = `Shared.${getSharedComponentName(componentName)}`;
        } else {
          typeCnt = getBodySchemaType(requestBody);
        }
        
        if (typeCnt) {
          typesFileContent += `export type I${endpoint.name}DTO = ${typeCnt};\n`;
        }
      }

      if (endpointSpec[method]?.responses) {
        // create request response types
        const responses: IOpenApiResponseSpec = endpointSpec[method]?.responses;
        const resCodes = Object.keys(responses);
        resCodes.forEach((code) => {
          let typeCnt = getBodySchemaType(responses[code]);
          if (typeCnt) {
            typesFileContent += `export type I${endpoint.name}${code}Response = ${typeCnt};\n`;
          }
        });
      }
    });
  });

  // Create the necessary directories
  const endpointsFilePath = path.join(rootUsingCwd, folderPath, "endpoints.ts");
  await fs.promises.mkdir(path.dirname(endpointsFilePath), { recursive: true });
  // Create the file asynchronously
  await fs.promises.writeFile(endpointsFilePath, endpointsFileContent);

  if (Object.values(sharedTypesFileContent).length > 0) {
    const sharedContent = Object.values(sharedTypesFileContent).join("\n");
    
    // const validation = validateTypeContent(sharedContent);
    
    // if (!validation.isValid) {
    //   logValidationErrors(validation.errors, 'shared.ts');
      
    //   // Write the invalid content to a debug file so you can inspect it
    //   const debugFilePath = path.join(rootUsingCwd, folderPath, "types", "shared.debug.ts");
    //   await fs.promises.mkdir(path.dirname(debugFilePath), { recursive: true });
    //   await fs.promises.writeFile(debugFilePath, sharedContent);
      
    //   console.error(`\n🔍 Invalid content written to: ${debugFilePath}`);
    //   console.error('Review this file to see exactly what was generated.');
      
    //   // return false; // Don't write the main file
    // }

    // Create the necessary directories
    const sharedTypesFilePath = path.join(
      rootUsingCwd,
      folderPath,
      "types",
      "shared.ts"
    );
    await fs.promises.mkdir(path.dirname(sharedTypesFilePath), {
      recursive: true,
    });
    // Create the file asynchronously
    await fs.promises.writeFile(
      sharedTypesFilePath,
      sharedContent
    );
  }

  if (typesFileContent.length > 0) {
    // Create the necessary directories
    const typesFilePath = path.join(
      rootUsingCwd,
      folderPath,
      "types",
      "index.ts"
    );
    await fs.promises.mkdir(path.dirname(typesFilePath), { recursive: true });
    // Create the file asynchronously
    await fs.promises.writeFile(
      typesFilePath,
      `${
        Object.values(sharedTypesFileContent).length > 0
          ? `import * as  Shared from "./shared";\n\n`
          : ""
      }${typesFileContent}`
    );
  }
};
export default OpenapiSync;
