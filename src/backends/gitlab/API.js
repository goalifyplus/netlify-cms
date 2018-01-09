import LocalForage from "Lib/LocalForage";
import { Base64 } from "js-base64";
import { isString } from "lodash";
import AssetProxy from "ValueObjects/AssetProxy";
import { APIError } from "ValueObjects/errors";

export default class API {
  constructor(config) {
    this.api_root = config.api_root || "https://gitlab.com/api/v4";
    this.token = config.token || false;
    this.branch = config.branch || "master";
    this.repo = config.repo || "";
    this.repoURL = `/projects/${ encodeURIComponent(this.repo) }`;
  }

  user() {
    return this.request("/user");
  }

  hasWriteAccess(user) {
    const WRITE_ACCESS = 30;
    return this.request(this.repoURL).then(({ permissions }) => {
      const { project_access, group_access } = permissions;
      if (project_access && (project_access.access_level >= WRITE_ACCESS)) {
        return true;
      }
      if (group_access && (group_access.access_level >= WRITE_ACCESS)) {
        return true;
      }
      return false;
    });
  }

  requestHeaders(headers = {}) {
    return {
      ...headers,
      ...(this.token ? { Authorization: `Bearer ${ this.token }` } : {}),
    };
  }

  urlFor(path, options) {
    const cacheBuster = `ts=${ new Date().getTime() }`;
    const encodedParams = options.params
          ? Object.entries(options.params).map(
            ([key, val]) => `${ key }=${ encodeURIComponent(val) }`)
          : [];
    return `${ this.api_root }${ path }?${ [cacheBuster, ...encodedParams].join("&") }`;
  }

  request(path, options = {}) {
    const headers = this.requestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    return fetch(url, { ...options, headers })
    .then((response) => {
      const contentType = response.headers.get("Content-Type");
      if (options.method === "HEAD" || options.method === "DELETE") {
        return Promise.all([response]);
      }
      if (contentType && contentType.match(/json/)) {
        return Promise.all([response, response.json()]);
      }
      return Promise.all([response, response.text()]);
    })
    .catch(err => Promise.reject([err, null]))
    .then(([response, value]) => (response.ok ? value : Promise.reject([value, response])))
    .catch(([errorValue, response]) => {
      const errorMessageProp = (errorValue && errorValue.message) ? errorValue.message : null;
      const message = errorMessageProp || (isString(errorValue) ? errorValue : "");
      throw new APIError(message, response && response.status, 'GitLab', { response, errorValue });
    });
  }
  
  readFile(path, sha, branch = this.branch) {
    const cache = sha ? LocalForage.getItem(`gh.${ sha }`) : Promise.resolve(null);
    return cache.then((cached) => {
      if (cached) { return cached; }
      
      return this.request(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }/raw`, {
        params: { ref: branch },
        cache: "no-store",
      })
      .then((result) => {
        if (sha) {
          LocalForage.setItem(`gh.${ sha }`, result);
        }
        return result;
      });
    });
  }

  fileDownloadURL(path, branch = this.branch) {
      return this.urlFor(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }/raw`, {
        params: { ref: branch },
      });
  }
  
  fileExists(path, branch = this.branch) {
    return this.request(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }`, {
      method: "HEAD",
      params: { ref: branch },
      cache: "no-store",
    }).then(() => true).catch(err => 
      // 404 can mean either the file does not exist, or if an API
      //   endpoint doesn't exist. We can't check this becaue we are
      //   not getting the content with a HEAD request.
      (err.status === 404 ? false : Promise.reject(err))
    );
  }

  listFiles(path) {
    return this.request(`${ this.repoURL }/repository/tree`, {
      params: { path, ref: this.branch },
    })
    .then(files => files.filter(file => file.type === "blob"));
  }

  persistFiles(files, options) {
    const uploads = files.map(async file => {
      const exists = await this.fileExists(file.path);
      return this.uploadAndCommit(file, {
        commitMessage: options.commitMessage,
        newFile: !exists,
      });
    });

    return Promise.all(uploads)
  }

  deleteFile(path, commit_message, options={}) {
    const branch = options.branch || this.branch;
    return this.request(`${ this.repoURL }/repository/files/${ encodeURIComponent(path) }`, {
      method: "DELETE",
      params: { commit_message, branch },
    });
  }

  toBase64(str) {
    return Promise.resolve(Base64.encode(str));
  }

  fromBase64(str) {
    return Base64.decode(str);
  }

  uploadAndCommit(item, {commitMessage, newFile = true, branch = this.branch}) {
    const content = item instanceof AssetProxy ? item.toBase64() : this.toBase64(item.raw);
    // Remove leading slash from path if exists.
    const file_path = item.path.replace(/^\//, '');
    
    // We cannot use the `/repository/files/:file_path` format here because the file content has to go
    //   in the URI as a parameter. This overloads the OPTIONS pre-request (at least in Chrome 61 beta).
    return content.then(contentBase64 => this.request(`${ this.repoURL }/repository/commits`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        branch,
        commit_message: commitMessage,
        actions: [{
          action: (newFile ? "create" : "update"),
          file_path,
          content: contentBase64,
          encoding: "base64",
        }]
      }),
    })).then(response => Object.assign({}, item, { uploaded: true }));
  }
}
