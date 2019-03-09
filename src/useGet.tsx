import { DebounceSettings } from "lodash";
import debounce from "lodash/debounce";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import url from "url";

import { Context, RestfulReactProviderProps } from "./Context";
import { GetState } from "./Get";
import { processResponse } from "./util/processResponse";

export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

export interface UseGetProps<TData> {
  /**
   * The path at which to request data,
   * typically composed by parent Gets or the RestfulProvider.
   */
  path: string;
  /** Options passed into the fetch call. */
  requestOptions?: RestfulReactProviderProps["requestOptions"];
  /**
   * Don't send the error to the Provider
   */
  localErrorOnly?: boolean;
  /**
   * A function to resolve data return from the backend, most typically
   * used when the backend response needs to be adapted in some way.
   */
  resolve?: (data: any) => TData;
  /**
   * Should we fetch data at a later stage?
   */
  lazy?: boolean;
  /**
   * An escape hatch and an alternative to `path` when you'd like
   * to fetch from an entirely different URL.
   *
   */
  base?: string;
  /**
   * How long do we wait between subsequent requests?
   * Uses [lodash's debounce](https://lodash.com/docs/4.17.10#debounce) under the hood.
   */
  debounce?:
    | {
        wait?: number;
        options: DebounceSettings;
      }
    | boolean
    | number;
}

async function _fetchData<TData, TError>(
  props: UseGetProps<TData>,
  state: GetState<TData, TError>,
  setState: (newState: GetState<TData, TError>) => void,
  context: RestfulReactProviderProps,
  signal: AbortSignal,
) {
  const { base = context.base, path, resolve = (d: any) => d as TData } = props;
  if (state.error || !state.loading) {
    setState({ ...state, error: null, loading: true });
  }

  const requestOptions =
    (typeof props.requestOptions === "function" ? props.requestOptions() : props.requestOptions) || {};
  requestOptions.headers = new Headers(requestOptions.headers);

  const request = new Request(url.resolve(base, path), requestOptions);
  try {
    const response = await fetch(request, { signal });
    const { data, responseError } = await processResponse(response);

    if (signal.aborted) {
      return;
    } else if (!response.ok || responseError) {
      const error = {
        message: `Failed to fetch: ${response.status} ${response.statusText}${responseError ? " - " + data : ""}`,
        data,
        status: response.status,
      };

      setState({ ...state, loading: false, error });

      if (!props.localErrorOnly && context.onError) {
        context.onError(error, () => _fetchData(props, state, setState, context, signal), response);
      }
    } else {
      setState({ ...state, loading: false, data: resolve(data) });
    }
  } catch (e) {
    setState({
      ...state,
      loading: false,
      error: {
        message: `Failed to fetch: ${e.message}`,
        data: e.message,
      },
    });
  }
}

export function useGet<TData = unknown, TError = unknown>(props: UseGetProps<TData>) {
  const context = useContext(Context);

  const fetchData = useCallback<typeof _fetchData>(
    typeof props.debounce === "object"
      ? debounce<typeof _fetchData>(_fetchData, props.debounce.wait, props.debounce.options)
      : typeof props.debounce === "number"
      ? debounce<typeof _fetchData>(_fetchData, props.debounce)
      : props.debounce
      ? debounce<typeof _fetchData>(_fetchData)
      : _fetchData,
    [props.debounce],
  );

  const [state, setState] = useState<GetState<TData, TError>>({
    data: null,
    response: null,
    loading: !props.lazy,
    error: null,
  });

  const abortController = useRef(new AbortController());
  const signal = abortController.current.signal;

  // We also probably need to recreate an abortController after abort
  // useEffect(() => {
  //   signal.addEventListener("abort", () => {
  //     abortController.current = new AbortController();
  //   });
  // }, []);

  const prevProps = useRef<UseGetProps<TData>>();
  useEffect(() => {
    const { base, path, resolve } = prevProps.current || { base: null, path: null, resolve: null };

    if (
      base !== props.base ||
      path !== props.path ||
      // both `resolve` props need to _exist_ first, and then be equivalent.
      (resolve && props.resolve && resolve.toString() !== props.resolve.toString())
    ) {
      if (!props.lazy) {
        fetchData(props, state, setState, context, signal);
      }
    }

    // Save props for later comparison
    prevProps.current = props;

    return () => abortController.current.abort();
  }, [props.path, props.base, props.resolve]);

  // TODO add queryParams

  return {
    ...state,
    absolutePath: url.resolve(props.base || context.base, props.path),
    refetch: (options: Partial<Omit<UseGetProps<TData>, "lazy">> = {}) =>
      fetchData({ ...props, ...options }, state, setState, context, signal),
  };
}