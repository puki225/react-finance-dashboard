import { useState, useEffect, useCallback } from 'react';

const BASE = '';

export function useApi(endpoint, params = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const query = new URLSearchParams(params).toString();
  const url = `${BASE}${endpoint}${query ? '?' + query : ''}`;

  const fetch_ = useCallback(() => {
    setLoading(true);
    fetch(url)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [url]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return { data, loading, error, refetch: fetch_ };
}
