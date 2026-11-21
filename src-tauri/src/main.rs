#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{redirect::Policy, Client, Url};
use serde_json::Value;
use std::time::Duration;
use tauri::State;

const MAX_RESPONSE_SIZE: usize = 1024 * 1024;

fn quote_endpoint(endpoint: &str) -> Result<Url, String> {
    let url = Url::parse(endpoint.trim()).map_err(|_| "服务器地址格式不正确".to_string())?;
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("请输入不带账号密码的行情接口地址".into());
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err("远程行情接口需使用 HTTPS，本机接口可使用 HTTP".into()),
    }
}

#[tauri::command]
async fn fetch_quotes(
    endpoint: String,
    token: Option<String>,
    client: State<'_, Client>,
) -> Result<Value, String> {
    let url = quote_endpoint(&endpoint)?;
    let mut request = client.get(url).header("Accept", "application/json");
    if let Some(token) = token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.bearer_auth(token);
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "请求行情接口超时".to_string()
        } else {
            "无法连接行情服务器".to_string()
        }
    })?;

    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "行情接口拒绝访问，请检查访问令牌".into(),
            404 => "未找到行情接口，请检查服务器地址".into(),
            503 => "服务器尚无可用行情".into(),
            status => format!("行情接口返回 HTTP {status}"),
        });
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取行情失败".to_string())?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_SIZE {
            return Err("行情响应过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "服务器未返回有效的行情数据".into())
}

fn main() {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirect(Policy::none())
        .build()
        .expect("failed to initialize quote client");

    tauri::Builder::default()
        .manage(client)
        .invoke_handler(tauri::generate_handler![fetch_quotes])
        .run(tauri::generate_context!())
        .expect("failed to launch looklook");
}
