package com.safealert.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = RedPrimary,
    secondary = BlueSecondary,
    surface = SurfaceLight,
    background = BackgroundLight,
    error = ErrorRed,
    onError = OnError,
    onPrimary = BackgroundLight,
    onSecondary = BackgroundLight,
    onSurface = OnSurface,
    onBackground = OnBackground
)

@Composable
fun SafeAlertTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColors,
        typography = AppTypography,
        content = content
    )
}
