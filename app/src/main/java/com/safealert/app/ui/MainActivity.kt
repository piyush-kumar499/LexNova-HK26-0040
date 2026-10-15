package com.safealert.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.safealert.app.ui.navigation.AppNavHost
import com.safealert.app.ui.theme.SafeAlertTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            SafeAlertTheme {
                AppNavHost()
            }
        }
    }
}
